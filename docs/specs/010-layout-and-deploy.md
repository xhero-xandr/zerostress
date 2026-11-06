# 010. Структура проекта, конфигурация и развёртывание

Статус: **согласовано 6 ноября 2026**. Часть «репозиторий» делается сейчас (ветка `feature/layout`), часть «сервер» (версии установок, общий `/var/lib/zerostress`, исходники вне `/opt`) после подачи на хакатон.

## 1. Цель и границы
Человек и агент должны находить любой файл без поиска, переносить сервис на новую машину одной командой и не путать код, настройки окружения и сгенерированные файлы. Спецификация задаёт раскладку репозитория, раскладку на сервере, место каждого конфига и порядок установки. Как работает каждый компонент, описано в 001–009, 011, 012.

## 2. Принципы (заданы владельцем проекта 6 ноября 2026)
1. **Предсказуемость.** Если разработчик тратит время на поиск файла, структура проиграла.
2. **Изоляция слоёв.** Код не смешивается с конфигурацией окружения и со сгенерированными файлами.
3. **Единообразие имён.** Только нижний регистр, без пробелов, слова через дефис (kebab-case).

## 3. На что опирались (проверено 6 ноября 2026)
- **FHS 3.0** (Linux Foundation, 19 марта 2015), по `hier(7)` из `man-pages-6.06` на Rocky 10 (сайт стандарта закрыт от автоматического чтения): `/opt` «add-on packages that contain static files»; `/etc/opt` и `/var/opt` для настроек и данных пакетов из `/opt`; `/var/lib` «variable state information»; `/var/cache` «data cached for programs».
- **systemd** `file-hierarchy(7)` и `systemd.exec(5)` (systemd 257): `/opt` не упоминается; `StateDirectory=` создаёт каталог в `/var/lib/`, `CacheDirectory=` в `/var/cache/`, `RuntimeDirectory=` в `/run/`, `ConfigurationDirectory=` в `/etc/`; `/var/cache` можно очистить без вреда, кроме времени на пересоздание.
- **The Twelve-Factor App** (Adam Wiggins, 12factor.net, обновлено в 2017): настройки в переменных окружения, проверка «код можно открыть, не раскрыв ключей»; строгое разделение build, release, run, выпуск неизменяем, у него уникальный идентификатор, откат к прошлому выпуску; логи в stdout, хранением занимается среда.

## 4. Решения

### 4.1 Корень репозитория говорит, где исполняется код
| Каталог | Где исполняется | Права |
|---|---|---|
| `supervisor/` | хост | привилегированно (только stdlib Go) |
| `web/` | хост, служба `zerostress-web`; `web/client/` в браузере посетителя | без привилегий |
| `guest/` | внутри микро-ВМ: `agent/` (Go), `collector/` (Playwright), `image/` (сборка образа) | непривилегированный пользователь гостя |
| `deploy/` | при установке на хост | root |
| `docs/` | — | — |
| `build/` | всё сгенерированное, в `.gitignore` целиком | — |

Причина: раньше код гостя лежал в двух местах (`collector/`, `guest-image/`), по имени не было видно, что оба уходят в ВМ. Каталог `probes/` удалён: решения, ради которых писались пробники, приняты и записаны (project.md, 005), сами файлы остались в истории git.

### 4.2 Сгенерированное только в `build/`
Бинарники супервизора и агента гостя, собранный клиент, рабочие файлы сборки образа, снимки браузерной проверки кладутся в `build/` (подкаталоги `supervisor/`, `guest-agent/`, `client/`, `image/`, `e2e/`). `rm -rf build/` ничего не ломает. Раньше они лежали рядом с исходниками (`supervisor/zerostress-supervisor`, `web/client/dist/`, снимки в `web/client/mockups/`, хотя это не макеты).

### 4.3 Конфиги окружения отдельными файлами, по пути назначения
Каждый файл, который ложится на хост, лежит в `deploy/files/` по своему пути на хосте: `deploy/files/etc/sudoers.d/zerostress-vm` ставится в `/etc/sudoers.d/zerostress-vm`. Скрипты только копируют (и подставляют значения в шаблоны `*.tmpl`). Раньше шесть конфигов были вписаны в скрипты (heredoc), а образец окружения лежал в корне и не совпадал с настоящим файлом.

| На хосте | В репозитории | Как ставится |
|---|---|---|
| `/etc/zerostress/web.env` | `deploy/files/etc/zerostress/web.env.example` | создаётся один раз из образца, дальше правится человеком (`sudoedit`); установщик не перезаписывает и называет недостающие переменные |
| `/etc/zerostress/supervisor.env` | `deploy/files/etc/zerostress/supervisor.env.example` | так же |
| `/etc/caddy/Caddyfile` | `deploy/files/etc/caddy/Caddyfile.tmpl` | шаблон: домен и диапазоны адресов Cloudflare |
| `/etc/systemd/system/*.service` | `deploy/files/etc/systemd/system/` | копия |
| `/etc/sudoers.d/zerostress-{vm,net}` | `deploy/files/etc/sudoers.d/` | копия, проверка `visudo -c` |
| `/etc/sysctl.d/90-zerostress.conf`, `/etc/tmpfiles.d/zerostress.conf`, `/etc/udev/rules.d/99-zerostress-kvm.rules` | `deploy/files/etc/…` | копия |
| `/opt/zerostress/bin/{zsvm,zsnet}` | `deploy/files/opt/zerostress/bin/` | копия |

**Настройки служб — это переменные окружения** в файлах `*.env` (формат `ИМЯ=значение`, читает systemd через `EnvironmentFile=`, служба файлов не читает), а не `*.conf`: так требует Twelve-Factor, а расширение честно говорит о формате. Ключ модели есть только в `/etc/zerostress/web.env` на хосте (права `0640 root:zerostress-web`). Каждая переменная описана в [../config.md](../config.md); тест падает, если код читает переменную, которой нет в образце. Локально: копия образца в `web/.env` (в `.gitignore`) и `npm run dev` (`node --env-file=.env`, встроено в Node 24).

Данные, которые едут вместе с кодом (правила хуков `web/hooks/rules/*.json`, промпт `web/agent/prompts/`), конфигами окружения не считаются: они версионируются с кодом и на сервере не правятся.

### 4.4 Версии в одном месте
`deploy/versions.env`: Node, Firecracker, Caddy, Go, ядро гостя, база Ubuntu, с хешами. Раньше версии были разбросаны по четырём скриптам и CI.

### 4.5 Установка по этапам, одна точка входа
`deploy/install.sh <этап>`: `host` (пользователи, kvm, SELinux, параметр ядра `spec_store_bypass_disable=seccomp`, sudoers, tmpfiles, udev), `network` (сеть гостей), `runtime` (Node, Firecracker, Caddy по хешам), `image` (сборка и установка образа гостя), `supervisor`, `web`, `verify`, `all`. Этапы лежат в `deploy/steps/` с номерами по порядку (`10-host.sh` … `90-verify.sh`). Раньше номера скриптов совпадали с номерами спецификаций (`001`, `002`, `003`, `006`, `010`) и не говорили о порядке; Node и Go ставились руками, параметр ядра тоже. `verify` проверяет службы, `healthz` и закрытость сети гостя; настоящую проверку ссылки запускает по флагу, потому что она тратит лимиты.

### 4.6 Тесты
- Go: рядом с кодом (`*_test.go`), этого требует сам Go.
- TypeScript и JavaScript: в каталоге `test/` модуля (`web/agent/test/`, `web/client/test/`, `guest/collector/test/`). Раньше клиент держал тесты рядом с кодом, остальной `web/` в `test/`.
- Тесты на настоящих микро-ВМ: только `deploy/test/` (в том числе бывшие `guest-image/test/`).

### 4.7 Имена
Нижний регистр, слова через дефис. Исключения только по требованию инструмента: `README.md`, `LICENSE`, `CLAUDE.md` (их ищут GitHub и Claude Code), `*_test.go` и `*_linux.go` (Go). Переименованы `docs/*.md` (`status.md`, `deploy.md`, …) и страницы клиента (`report.tsx`, …).

### 4.8 Сервер (цель; переход после хакатона)
```
/opt/zerostress/releases/<дата>-<коммит>/   неизменяемый выпуск: bin/, web/, VERSIONS
/opt/zerostress/current -> releases/…       службы смотрят сюда, откат = сменить ссылку
/opt/zerostress/images/<ядро>-pw<версия>/   образ гостя, свой цикл обновления; images/current
/opt/zerostress/runtime/node-v<версия>/      свой Node, не общий /opt/node
/etc/zerostress/{web,supervisor}.env         настройки и ключ
/var/lib/zerostress/{supervisor,web}/        состояние (StateDirectory=)
/var/cache/zerostress/                       geo-таблицы, загрузки сборки (CacheDirectory=)
/run/zerostress/                             сокет (RuntimeDirectory=)
/home/linuxuser/src/zerostress/              исходники, пока сервер служит и для разработки
```
**Отступление от FHS, осознанное:** по FHS настройки и данные пакета из `/opt` лежат в `/etc/opt/zerostress` и `/var/opt/zerostress`. Мы держим их в `/etc/zerostress` и `/var/lib/zerostress`, как велит systemd: эти каталоги создаёт сам systemd с нужными правами (`StateDirectory=` и т. д.), служба `zerostress-web` уже так работает вместе с `ProtectSystem=strict`; `/var/opt` systemd создавать не умеет. Программа в `/opt`, а не в `/usr`, потому что `/usr` по `file-hierarchy(7)` принадлежит пакетам дистрибутива.

Сейчас (до перехода): программа в `/opt/zerostress/{bin,supervisor,web,images}`, состояние в `/var/lib/zerostress` и `/var/lib/zerostress-web`, исходники в `/opt/zerostress-src`, Node и Go в `/opt/node` и `/opt/go`. Установщик ставит туда же, что и раньше: смена путей на работающем сервере перед подачей не делается.

## 5. Как работать
| Задача | Что делать |
|---|---|
| Изменить код | исходники → тесты → коммит |
| Выкатить | `sudo deploy/install.sh supervisor` или `web` (в конце `verify`) |
| Изменить ключ или лимиты | `sudoedit /etc/zerostress/web.env`, `sudo systemctl restart zerostress-web` |
| Новый сервер | `git clone`, `sudo deploy/install.sh all`, скопировать `web.env`, `sudo deploy/install.sh verify`, DNS |
| Логи | `journalctl -u zerostress-web -u zerostress-supervisor` |

Агент: исходники свободно; установка в бой только с явного разрешения владельца; значения из `/etc/zerostress/*.env` не читает и не печатает (только имена).

## 6. Проверка
- Все тесты, мутации (web, Go), браузерная проверка CSP и сборка проходят после переноса.
- Конфиги из `deploy/files/` побайтно совпадают с установленными на сервере (проверка без записи на хост: `deploy/test/files-match.sh`).
- `bash -n` для всех скриптов; `install.sh` без этапа печатает справку.
- Тест образца окружения: каждая переменная, которую читает код, есть в образце.

## 7. Что проверено и что нет
**Проверено 6–7 ноября 2026, ветка `feature/layout`:**
- Тесты после переноса: `web/` 527 (в том числе новый `env-example.test.ts`), клиент 32, сборщик 43, Go `supervisor` и `guest/agent` с `-race`, `gofmt`, `go vet`, `actionlint`; мутации Go 13/13, мутации клиента из общего набора 16/16.
- Тест образцов окружения ловит все семь контрольных поломок: переменная пропала из образца (web, supervisor), мёртвая переменная в образце (web, supervisor), переменная не описана в `config.md` (web, supervisor), ключ вписан в образец.
- Все десять файлов из `deploy/files/` (юниты, sudoers, sysctl, tmpfiles, udev, `zsvm`, `zsnet`) побайтно совпадают с установленными на сервере; Caddyfile из шаблона с текущими диапазонами Cloudflare совпадает с рабочим.
- `install.sh verify` на боевом сервере: 24 проверки из 25, единственная находка — мёртвая переменная `AGENT_MODE` в `/etc/zerostress/web.env` (её писал старый `001-host-baseline.sh`, код её не читает).
- Браузерная проверка CSP с клиентом из `build/client`, снимки в `build/e2e`.
- На настоящих микро-ВМ после переноса тестов в `deploy/test/`: `image-smoke.sh`, `image-net-isolation.sh`, `image-collector.sh` проходят, после них не остаётся ВМ, интерфейсов и каталогов запусков.
- Сборка образа из `deploy/versions.env` за 46 с (загрузки из кэша): манифест с теми же хешами ядра, базы и Node, Playwright 1.65.0, по умолчанию настоящий сборщик (хеш в манифесте совпадает с `collect.mjs` + `lib/`). Образ не установлен.

**Не проверено:** этапы `host`, `network`, `runtime`, `image`, `supervisor`, `web` в новом виде на сервере (бой не трогали; логика перенесена из прежних скриптов без изменений, кроме: рантайм ставится, только если версия другая; параметр ядра выставляет `host`; сборки идут от владельца рабочей копии); `install.sh all` на чистой машине (нужна временная ВМ Vultr с KVM); тесты `supervisor-*-e2e.sh`, `collector-e2e.sh`, `agent-e2e.sh`, `containment-e2e.sh` после переноса (пути в них проверены на существование, сами тесты не запускались: они подменяют установленный образ или службу).

## 8. Открытые вопросы
1. Сборка выпусков в CI вместо сборки на сервере (Twelve-Factor, build отдельно от release): после хакатона.
2. Списки в `web/agent/lists.ts` (бренды, сокращатели, расширения) это данные; перенос в `web/agent/data/*.json`: после хакатона.
