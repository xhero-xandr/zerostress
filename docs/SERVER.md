# Сервер разработки: что на нём есть и как с ним работать

Состояние проверено 4 ноября 2026, после перезагрузки хоста и сквозной проверки с нуля (скрипты хоста, сборка агента и образа, установка, дымовой тест и тест сети). Доступ: `ssh vultr` (под `root`, на время разработки; перед публичным запуском вход `root` нужно закрыть, см. [спецификацию 001](specs/001-host-baseline.md), раздел 4.7).

## Что установлено
| Путь | Что | Откуда |
|---|---|---|
| `/opt/zerostress/bin/firecracker` | Firecracker v1.17.0 | официальный релиз, хеш закреплён в `deploy/001-host-baseline.sh` |
| `/opt/zerostress/bin/zsnet` | скрипт сети слотов (`up N`, `down N`, N от 0 до 3) | `deploy/zsnet`, ставит `deploy/003-network.sh` |
| `/opt/zerostress/bin/zsvm` | root-помощник: запускает Firecracker юнитом systemd с лимитами (`run`, `stop`, `recover`) | `deploy/zsvm`, ставит `deploy/002-vm-runner.sh` (его вызывает `006-supervisor.sh`) |
| `/opt/zerostress/supervisor/zerostress-supervisor`, `zerostress-supervisor.service` | бинарник и служба супервизора | `supervisor/build.sh`, затем `deploy/006-supervisor.sh` |
| `/opt/zerostress/images/` | ядро гостя, `guest-rootfs.ext4`, `manifest.json` | `guest-image/build.sh`, ставит `guest-image/install.sh` |
| `/opt/node` | Node 24.22.2 только для вспомогательных скриптов тестов хоста (супервизору не нужен) | официальный архив, сумма проверена по `SHASUMS256.txt` |
| `/opt/go` | Go 1.27.3, только для сборки агента | архив с go.dev, сумма проверена |
| `/opt/zerostress-src` | копия рабочего дерева (без git) | `deploy/dev-sync.sh` с локальной машины |
| `/var/lib/zerostress/runs` | каталоги запусков, на каждый запуск свой, после него удаляется | супервизор (тесты создают и убирают сами) |
| `/run/zerostress` | каталог для сокета супервизора | `tmpfiles.d` создаёт при каждой загрузке |
| `/etc/zerostress/web.env` | окружение веб-слоя, здесь живёт ключ Vultr Inference (`root:zerostress-web`, `0640`); читают только `root` и `zerostress-web` | создаёт `deploy/001-host-baseline.sh` один раз, повторный запуск не перезаписывает |
| `/etc/zerostress/supervisor.env` | настройки супервизора без секретов (`root:zerostress-sup`, `0640`) | то же |

Системные настройки: пользователи `zerostress-sup` (группа `kvm`) и `zerostress-web`, группа `zerostress-ipc`; `/dev/kvm` с правами `0660` (правило udev); зона `zerostress` и политика `zerostress-egress` в `firewalld`; `net.ipv4.ip_forward=1` (`/etc/sysctl.d/90-zerostress.conf`); правило sudoers только для `zsnet up|down` (`/etc/sudoers.d/zerostress-net`). Таблица `inet zerostress` в nftables создаётся при первом `zsnet up` и после перезагрузки отсутствует до него, это нормально. Наружу слушает только `sshd`. SELinux в режиме `Enforcing`.

Проект называется ZeroStress. 4 ноября 2026 сервер приведён к этому имени целиком: учётные записи переименованы на месте (uid, gid и владельцы файлов сохранились), каталоги перенесены, а юнит, sudoers, правила `sysctl`, `tmpfiles`, `udev` и SELinux, зона и политика `firewalld` и таблица nftables пересозданы скриптами из репозитория. Образ гостя пересобран под новое имя агента.

Из служб проекта работает только `zerostress-supervisor` (Go, статический бинарник); веб-слоя и прокси пока нет. Следы экспериментов (Rust, старые образы, ключи, временные файлы) удалены; от сборок остаются только кэши Go в домашнем каталоге `linuxuser`.

## Как работать
```
bash deploy/dev-sync.sh                                   # локально: отправить рабочее дерево на сервер
ssh vultr 'sudo -u linuxuser bash /opt/zerostress-src/guest-image/build-agent.sh'   # тесты и сборка агента
ssh vultr 'AGENT_BIN=/opt/zerostress-src/guest-image/agent/zerostress-agent bash /opt/zerostress-src/guest-image/build.sh'   # образ в /var/tmp/zerostress-build/out
ssh vultr 'bash /opt/zerostress-src/guest-image/install.sh'                          # установить образ в /opt/zerostress/images
ssh vultr 'bash /opt/zerostress-src/guest-image/test/smoke.sh'                       # дымовой тест образа, Chromium и сеть
ssh vultr 'bash /opt/zerostress-src/guest-image/test/net-isolation.sh'               # изоляция сети двух гостей
ssh vultr 'bash /opt/zerostress-src/guest-image/test/collector.sh'                   # настоящий сборщик в настоящей ВМ на example.com (сборщик кладётся поверх установленного образа)
ssh vultr 'bash /opt/zerostress-src/deploy/test/mutate-artifacts.sh'                  # проверка тестов выдачи артефактов мутациями: 13 правок, тесты обязаны упасть (после dev-sync)
ssh vultr 'bash /opt/zerostress-src/deploy/test/collector-e2e.sh'                    # настоящий сборщик за супервизором (образ подменяется на время теста и возвращается)
ssh vultr 'bash /opt/zerostress-src/guest-image/test/session.sh'                     # сессии агента v2 по настоящему vsock (сначала build-agent.sh: dev-sync стирает бинарник)
ssh vultr 'bash /opt/zerostress-src/deploy/test/unit-compat.sh LABEL PROP...'        # совместимость параметров юнита с SELinux (см. спецификацию 006)
ssh vultr 'sudo -u linuxuser bash /opt/zerostress-src/supervisor/build.sh'            # проверки, тесты с -race и сборка супервизора
ssh vultr 'bash /opt/zerostress-src/deploy/006-supervisor.sh'                        # установить и запустить службу супервизора
ssh vultr 'bash /opt/zerostress-src/deploy/test/supervisor-e2e.sh'                   # сквозной тест службы с настоящими ВМ (47 проверок)
ssh vultr 'bash /opt/zerostress-src/deploy/test/supervisor-timeouts.sh'              # лимит агента 60 с и жёсткий потолок (около 2 минут, временно меняет юнит и восстанавливает)
ssh vultr 'bash /opt/zerostress-src/deploy/test/supervisor-sessions-e2e.sh'          # сессии: команды, подтверждения, простой, слоты, падения (около 3 минут; нужен образ с актуальной заглушкой)
ssh vultr '/opt/node/bin/node --disable-warning=ExperimentalWarning /opt/zerostress-src/deploy/test/bench-concurrency.mjs'   # замер параллельности с Chromium (около 3 минут, временно меняет юнит и восстанавливает)
ssh vultr 'bash /opt/zerostress-src/deploy/test/zsvm-helper.sh'                       # помощник zsvm: отклоняет всё неверное, кто может его вызывать
ssh vultr 'bash /opt/zerostress-src/deploy/test/zsvm-probe.sh'                        # разведочная проба юнита на ВМ: лимиты cgroup, сигналы, очистка (остановите службу супервизора на время теста)
```
Отказы SELinux на этом сервере читаются прямо из `/var/log/audit/audit.log` и `audit.log.1` (лог ротируется при 8 МБ): `ausearch` ничего не находит даже по номеру записи.
После сборки образа каталог `/var/tmp/zerostress-build` (около 1,6 ГБ) удаляется вручную: `rm -rf /var/tmp/zerostress-build`.

Первичная настройка чистого хоста Rocky Linux 10: `deploy/001-host-baseline.sh`, затем `deploy/003-network.sh`, затем сборка и установка образа, как выше (Node и Go ставятся отдельно, процедура описана в разделе «Что установлено», скрипта для них пока нет).

## Правило порядка
Всё, что создают тесты (ВМ, интерфейсы `zstap*`, каталоги запусков, loop-монтирования), они убирают сами через `trap`. Если запуск прервали, проверка: `pgrep firecracker`, `ip -br link | grep zstap`, `ls /var/lib/zerostress/runs`, `losetup -a`: везде должно быть пусто.

## Домен
`zerostress.space`, DNS через Cloudflare с проксированием (проверено 4 ноября 2026: имя отдаёт адреса Cloudflare). Caddy и сертификат на сервере ещё не настроены; режим TLS между Cloudflare и сервером (Full strict с сертификатом Cloudflare Origin или обычный Let's Encrypt) выбираем при настройке прокси, см. docs/TOOLS.md, раздел 8.
