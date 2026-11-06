# Развёртывание и сервер

Как ставить, обновлять, проверять и переносить ZeroStress. Решения и их причины: [specs/010-layout-and-deploy.md](specs/010-layout-and-deploy.md); каждая настройка: [config.md](config.md).

Сервер сейчас: Vultr, Rocky Linux 10, KVM, `ssh vultr` (под `root` на время разработки; перед публичным запуском вход `root` закрыть, [спецификация 001](specs/001-host-baseline.md), раздел 4.7). Домен `zerostress.space`, DNS и прокси Cloudflare (Full strict), сертификат Let's Encrypt у Caddy.

## Три места
| Где | Что | Кто меняет |
|---|---|---|
| рабочая копия `/opt/zerostress-src` (git) | исходники | человек и агент: правка, тесты, коммит |
| `/opt/zerostress`, `/opt/node`, `/opt/go`, `/usr/local/bin/caddy` | установленная программа и рантайм | только `deploy/install.sh` |
| `/etc/zerostress/*.env` | настройки и ключ модели | человек, `sudoedit` |
| `/var/lib/zerostress`, `/var/lib/zerostress-web`, `/run/zerostress` | состояние: запуски ВМ, база супервизора, отчёты, сокет | сами службы |

Код меняется только в рабочей копии, настройки только в `/etc/zerostress`, в `/opt` и `/var` руками не ходим. Целевая раскладка после хакатона (выпуски `releases/` со ссылкой `current`, общий `/var/lib/zerostress`, исходники вне `/opt`): спецификация 010, 4.8.

### Что установлено и откуда
| На хосте | Из репозитория | Этап |
|---|---|---|
| `/opt/zerostress/bin/firecracker` | версия и хеш в `deploy/versions.env` | `runtime` |
| `/opt/zerostress/bin/zsvm`, `zsnet` | `deploy/files/opt/zerostress/bin/` | `supervisor`, `network` |
| `/opt/zerostress/supervisor/zerostress-supervisor` | `supervisor/` → `build/supervisor/` | `supervisor` |
| `/opt/zerostress/web/` (`server`, `agent`, `hooks`, `node_modules`, `client/dist`) | `web/`, клиент → `build/client/` | `web` |
| `/opt/zerostress/images/` (ядро, `guest-rootfs.ext4`, `manifest.json`) | `guest/` → `/var/tmp/zerostress-build/out` | `image` |
| `/opt/node`, `/opt/go`, `/usr/local/bin/caddy` | `deploy/versions.env` | `runtime` |
| юниты, sudoers, sysctl, tmpfiles, udev | `deploy/files/etc/` (побайтно) | `host`, `network`, `supervisor`, `web` |
| `/etc/caddy/Caddyfile` | `deploy/files/etc/caddy/Caddyfile.tmpl` + домен + диапазоны Cloudflare | `web` |
| `/etc/zerostress/{web,supervisor}.env` | `deploy/files/etc/zerostress/*.env.example`, один раз | `host` |
| параметр ядра `spec_store_bypass_disable=seccomp` | `grubby` | `host` |

Системные настройки: пользователи `zerostress-sup` (группа `kvm`) и `zerostress-web`, группа `zerostress-ipc`; `/dev/kvm` `0660`; зона `zerostress` и политика `zerostress-egress` в `firewalld`; таблица `inet zerostress` в nftables появляется при первом `zsnet up` (после перезагрузки её нет до первого запуска ВМ, это нормально). Наружу слушают `sshd` и Caddy (80, 443). SELinux `Enforcing`. Параметр ядра (6 ноября 2026): процессы под seccomp, в том числе каждый Firecracker, принудительно защищены от Speculative Store Bypass (`/proc/<pid>/status`: было `thread vulnerable`, стало `thread force mitigated`).

## Установка
```
sudo deploy/install.sh all              # новый хост: все этапы по порядку
sudo deploy/install.sh <этап>           # host | network | runtime | image | supervisor | web | verify
sudo deploy/install.sh verify [--live]  # сверить хост с репозиторием, ничего не меняя
```
Этапы лежат в `deploy/steps/` (`10-host.sh` … `90-verify.sh`), общие функции в `deploy/lib.sh`. Все этапы можно повторять. Сборки (`supervisor/build.sh`, `guest/agent/build.sh`, клиент) идут от владельца рабочей копии, не от `root`. Для `web` домен задаётся `DOMAIN=…` (по умолчанию `zerostress.space`).

`verify` проверяет службы, ответы супервизора и веб-слоя, KVM, параметр ядра, версии рантайма, имена переменных в `/etc/zerostress/*.env` (значения не печатает) и побайтное совпадение каждого файла из `deploy/files/` с установленным; `--live` дополнительно гоняет одну настоящую проверку `https://example.com/` через публичный адрес (запускает ВМ и тратит лимит).

### Переезд на новый хост
1. ВМ Vultr с KVM (Firecracker без `/dev/kvm` не работает; этап `host` проверяет это первым), Rocky Linux 10.
2. `git clone https://github.com/xhero-xandr/zerostress && cd zerostress`
3. `sudo deploy/install.sh host`, затем вписать ключ в `/etc/zerostress/web.env` (`sudoedit`) и перезагрузить, если этап попросил (параметр ядра).
4. `sudo deploy/install.sh all` (около 15 минут, больше всего занимает образ гостя).
5. `sudo deploy/install.sh verify --live`, затем переключить DNS в Cloudflare.

Отчёты живут 24 часа, переносить их не нужно. Не проверено: установка с нуля на чистой машине после перехода на `install.sh` (нужна временная ВМ).

### Обновление
| Что изменилось | Команда |
|---|---|
| веб-слой, клиент, хуки, агент, промпт | `sudo deploy/install.sh web` |
| супервизор | `sudo deploy/install.sh supervisor` |
| сборщик или агент гостя (меняется образ) | `sudo deploy/install.sh image`, затем `supervisor` |
| версия в `deploy/versions.env` | `sudo deploy/install.sh runtime`, затем этап, который её использует |
| настройка | `sudoedit /etc/zerostress/web.env`, `sudo systemctl restart zerostress-web` |

После сборки образа `/var/tmp/zerostress-build/out` (около 1,5 ГБ) можно удалить; `dl/` (загрузки с проверенными суммами) ускоряет следующую сборку.

## Рабочая копия
`/opt/zerostress-src` (git, владелец `linuxuser`, локальный конфиг автора `xhero-xandr <devp.xandr@gmail.com>`, `root` добавил каталог в `safe.directory`). Удалённый репозиторий: https://github.com/xhero-xandr/zerostress (`origin`). Пуш делает владелец (у этой оболочки нет доступа к GitHub). Всё сгенерированное лежит в `build/` (в `.gitignore`), `rm -rf build/` ничего не ломает.

Локальный запуск веб-слоя: `cp deploy/files/etc/zerostress/web.env.example web/.env`, вписать `WEB_CLIENT_DIR=../build/client`, собрать клиент (`npm run build` в `web/client`), `npm run dev` в `web/`.

## Тесты
Без KVM (идут и в CI): `npm test` и `npm run typecheck` в `web/` и `web/client/`, `npm run e2e` в `web/client/` (браузерная проверка CSP, Chromium от обычного пользователя), `npm test` в `guest/collector/`, `go test -race ./...` в `supervisor/` и `guest/agent/`, `deploy/test/mutate-artifacts.sh`. Мутации веб-слоя: `npm run mutate` в `web/` (около 40 минут).

На настоящих микро-ВМ (только на хосте, от `root`; всё, что создают, убирают сами):
```
deploy/test/image-smoke.sh            # образ: оверлей, загрузка, агент по vsock, Chromium, сеть
deploy/test/image-net-isolation.sh    # изоляция сети двух гостей
deploy/test/image-collector.sh        # настоящий сборщик в ВМ на example.com
deploy/test/image-session.sh          # сессии агента по настоящему vsock
deploy/test/supervisor-e2e.sh         # служба супервизора с настоящими ВМ (47 проверок; образ с заглушкой сборщика)
deploy/test/supervisor-sessions-e2e.sh  # команды, подтверждения, простой, слоты (около 3 минут)
deploy/test/supervisor-timeouts.sh    # сроки (около 2 минут; временно меняет юнит)
deploy/test/collector-e2e.sh          # настоящий сборщик за супервизором (образ подменяется на время теста)
deploy/test/agent-e2e.sh              # агент целиком: супервизор, ВМ, сборщик, хуки, настоящая модель
deploy/test/containment-e2e.sh        # изоляция изнутри ВМ: метаданные облака, хост, внутренние сети
deploy/test/zsvm-helper.sh            # zsvm отклоняет всё неверное
deploy/test/zsvm-probe.sh             # проба юнита ВМ: cgroup, сигналы, очистка (остановите супервизор)
deploy/test/unit-compat.sh LABEL PROP...  # совместимость параметров юнита с SELinux
```
Тестам образа нужен агент (`guest/agent/build.sh`); заглушка сборщика `deploy/test/stub-collector.mjs`. Образ с заглушкой собирается явно: `COLLECTOR_ENTRY=deploy/test/stub-collector.mjs guest/image/build.sh` (по умолчанию теперь настоящий сборщик).

Если тест прервали: `pgrep firecracker`, `ip -br link | grep zstap`, `ls /var/lib/zerostress/runs`, `losetup -a` должны быть пусты. Отказы SELinux читаются из `/var/log/audit/audit.log` и `audit.log.1` (`ausearch` на этом сервере ничего не находит).
