# Развёртывание и сервер

Всё живёт в одном каталоге проекта — это рабочая копия git, на сервере `/zerostress` — и всем управляет одна команда `./zs`. Решения и причины: [specs/010-layout-and-deploy.md](specs/010-layout-and-deploy.md); каждая настройка: [config.md](config.md).

Сервер: Vultr, Rocky Linux 10, KVM, SELinux Enforcing, `ssh vultr` (под `root` на время разработки; перед публичным запуском вход `root` закрыть, [спецификация 001](specs/001-host-baseline.md), раздел 4.7). Домен `zerostress.space`, DNS и прокси Cloudflare (Full strict), сертификат Let's Encrypt у Caddy.

## Что где лежит
```
/zerostress/
├── zs                       одна команда на всё
├── config/                  web.env (+ ключ модели), supervisor.env — правит человек; Caddyfile — делает zs
├── supervisor/ web/ guest/ deploy/ docs/       код (git)
├── bin/                     firecracker, zsvm, zsnet, caddy, zerostress-supervisor (root)
├── runtime/                 node, go
├── images/                  образ гостевой ВМ
├── data/                    supervisor/ (запуски ВМ, база), web/ (отчёты), geo/, caddy/ (сертификаты)
├── logs/                    web.log, supervisor.log, caddy.log
├── run/                     supervisor.sock
└── build/                   всё, что делают сборки
```
Код меняется в git, настройки — `./zs config`, остальное заполняют `./zs install` и сами службы. Вне каталога только то, что система читает лишь из своих мест: юниты, правила sudo, sysctl, udev, logrotate (`deploy/files/`, ставит `./zs install`, руками не правятся), метки SELinux и зона firewalld.

## Команды
```
./zs install [этап…]     host | network | runtime | image | supervisor | web | verify; без этапа — все (sudo)
./zs update              git pull, сборка и перезапуск супервизора и сайта, verify
./zs start|stop|restart|status
./zs logs [web|supervisor|caddy] [-f]
./zs config [web|supervisor]     правка настроек и перезапуск службы
./zs verify [--live]     сверить хост с репозиторием, ничего не меняя
./zs dev                 сайт из рабочей копии на порту 8081, со своими данными в build/dev
```
`verify` проверяет службы, ответы супервизора и сайта, KVM, параметр ядра, версии, владельцев `bin/`, типы SELinux, имена переменных в `config/*.env` (значения не печатает) и побайтное совпадение файлов из `deploy/files/`; `--live` дополнительно гоняет одну настоящую проверку `https://example.com/` через публичный адрес (запускает ВМ и тратит лимит).

## Новый сервер
1. ВМ Vultr с KVM (без `/dev/kvm` Firecracker не работает; этап `host` проверяет это первым), Rocky Linux 10.
2. `git clone https://github.com/xhero-xandr/zerostress /zerostress && cd /zerostress`
3. `sudo ./zs install host`, затем `./zs config web` (ключ модели) и перезагрузка, если этап попросил (параметр ядра).
4. `sudo ./zs install` (около 15 минут, больше всего занимает образ гостя).
5. `./zs verify --live`, затем DNS в Cloudflare.

Переезд: то же, плюс `config/` и, если нужны отчёты, `data/` со старого сервера. Не проверено: установка на чистой машине.

## Обновление
| Что изменилось | Команда |
|---|---|
| код сайта, агента, хуков, супервизора | `./zs update` |
| только сайт или только супервизор | `sudo ./zs install web` / `supervisor` |
| сборщик или агент гостя (меняется образ) | `sudo ./zs install image supervisor` |
| версия в `deploy/versions.env` | `sudo ./zs install runtime`, затем этап, который её использует |
| настройка | `./zs config web` |

## Переезд со старой раскладки (один раз)
Сервер до 7 ноября 2026 жил по старой раскладке (переехал 7 ноября; осталось `cleanup`): программа в `/opt/zerostress`, рабочая копия в `/opt/zerostress-src`, настройки в `/etc/zerostress`, данные в `/var/lib/zerostress*`. Переезд:
```
sudo mv /opt/zerostress-src /zerostress && cd /zerostress
sudo deploy/migrate-from-opt.sh prepare     # без простоя
sudo deploy/migrate-from-opt.sh switch      # около минуты простоя; при сбое старое возвращается само
sudo deploy/migrate-from-opt.sh rollback    # если нужно вернуть старую раскладку руками
sudo deploy/migrate-from-opt.sh cleanup     # когда новая раскладка поработала: удалить старые места
```

## Разработка
- Рабочая копия на сервере: `/zerostress` (переезд 7 ноября 2026), владелец `linuxuser`, локальный конфиг автора `xhero-xandr <devp.xandr@gmail.com>`. Удалённый репозиторий: https://github.com/xhero-xandr/zerostress (`origin`); пуш делает владелец.
- Сайт работает прямо из рабочей копии: правка `web/` попадает в бой при перезапуске службы (`./zs update` или `./zs restart`). Пробовать изменения — `./zs dev`.
- У разработчика на своей машине: `git clone`, `cp config/web.env.example config/web.env` (ключ по желанию), `./zs dev`. Без KVM настоящие проверки ссылок не идут (нет супервизора); интерфейс, отчёт и чат работают.

## Тесты
Без KVM (идут и в CI): `npm test` и `npm run typecheck` в `web/` и `web/client/`, `npm run e2e` в `web/client/` (браузерная проверка CSP, Chromium от обычного пользователя), `npm test` в `guest/collector/`, `supervisor/build.sh` и `guest/agent/build.sh` (тесты с `-race`), `deploy/test/mutate-artifacts.sh`. Мутации веб-слоя: `npm run mutate` в `web/` (около 40 минут).

На настоящих микро-ВМ (только на сервере, от `root`; всё, что создают, убирают сами; указывают на `/zerostress`):
```
deploy/test/image-smoke.sh            образ: оверлей, загрузка, агент по vsock, Chromium, сеть
deploy/test/image-net-isolation.sh    изоляция сети двух гостей
deploy/test/image-collector.sh        настоящий сборщик в ВМ на example.com
deploy/test/image-session.sh          сессии агента по настоящему vsock
deploy/test/supervisor-e2e.sh         служба супервизора с настоящими ВМ (47 проверок; образ с заглушкой сборщика)
deploy/test/supervisor-sessions-e2e.sh  команды, подтверждения, простой, слоты (около 3 минут)
deploy/test/supervisor-timeouts.sh    сроки (около 2 минут; временно меняет юнит)
deploy/test/collector-e2e.sh          настоящий сборщик за супервизором (образ подменяется на время теста)
deploy/test/agent-e2e.sh              агент целиком: супервизор, ВМ, сборщик, хуки, настоящая модель
deploy/test/containment-e2e.sh        изоляция изнутри ВМ: метаданные облака, хост, внутренние сети
deploy/test/zsvm-helper.sh            zsvm отклоняет всё неверное
deploy/test/zsvm-probe.sh             проба юнита ВМ: cgroup, сигналы, очистка (остановите супервизор)
deploy/test/unit-compat.sh LABEL PROP...  совместимость параметров юнита с SELinux
```
Тестам образа нужен агент (`guest/agent/build.sh`). Образ с заглушкой сборщика собирается явно: `COLLECTOR_ENTRY=deploy/test/stub-collector.mjs guest/image/build.sh` (по умолчанию — настоящий сборщик).

Если тест прервали: `pgrep firecracker`, `ip -br link | grep zstap`, `ls /zerostress/data/supervisor/runs`, `losetup -a` должны быть пусты. Отказы SELinux читаются из `/var/log/audit/audit.log` (`ausearch` на этом сервере ничего не находит).

## Системные настройки
Пользователи `zerostress-sup` (группа `kvm`), `zerostress-web`, `caddy`, группа `zerostress-ipc`; `/dev/kvm` `0660`; зона `zerostress` и политика `zerostress-egress` в `firewalld`; таблица `inet zerostress` в nftables появляется при первом `zsnet up`. Наружу слушают `sshd` и Caddy (80, 443). Параметр ядра `spec_store_bypass_disable=seccomp` (6 ноября 2026): процессы под seccomp, в том числе каждый Firecracker, принудительно защищены от Speculative Store Bypass (`/proc/<pid>/status`: было `thread vulnerable`, стало `thread force mitigated`).
