# Настройки

Где что настраивается и что значит каждая переменная. Решения и причины: [specs/010-layout-and-deploy.md](specs/010-layout-and-deploy.md). Тесты `web/server/test/env-example.test.ts` и `supervisor/envexample_test.go` падают, если код читает переменную, которой нет в образце или здесь.

## Где лежат
| Что | На сервере | Образец в репозитории | Кто читает | Секрет |
|---|---|---|---|---|
| Настройки сайта и агента | `/etc/zerostress/web.env` | [deploy/files/etc/zerostress/web.env.example](../deploy/files/etc/zerostress/web.env.example) | служба `zerostress-web` (через `EnvironmentFile=`) | **да**: `INFERENCE_API_KEY` |
| Настройки ВМ и очереди | `/etc/zerostress/supervisor.env` | [deploy/files/etc/zerostress/supervisor.env.example](../deploy/files/etc/zerostress/supervisor.env.example) | служба `zerostress-supervisor` | нет |
| Прокси | `/etc/caddy/Caddyfile` | [deploy/files/etc/caddy/Caddyfile.tmpl](../deploy/files/etc/caddy/Caddyfile.tmpl) | `caddy` | нет; делается из шаблона, руками не правится |
| Остальные файлы хоста (юниты, sudoers, sysctl, tmpfiles, udev, помощники) | по путям в `deploy/files/` | [deploy/files/](../deploy/files/) | systemd, sudo, ядро | нет; руками не правятся |
| Версии и хеши | — | [deploy/versions.env](../deploy/versions.env) | установщик, сборка образа | нет |

Правила: файл `*.env` создаёт `deploy/install.sh host` из образца один раз и больше не перезаписывает; правится через `sudoedit`, после правки `sudo systemctl restart <служба>`. `sudo deploy/install.sh verify` сверяет имена (значения не печатает): называет переменные из образца, которых нет в файле, и переменные, которые никто не читает. Строки без `#` в образце заданы намеренно, закомментированные показывают значение по умолчанию.

Локально (без сервера): `cp deploy/files/etc/zerostress/web.env.example web/.env`, вписать `WEB_CLIENT_DIR=../build/client` и, если нужен, ключ; `web/.env` в `.gitignore`.

## web.env
### Модель (Vultr Serverless Inference)
| Переменная | По умолчанию | Что делает |
|---|---|---|
| `INFERENCE_BASE_URL` | пусто (в образце `https://api.vultrinference.com/v1`) | адрес OpenAI-совместимого API; только `https` (http только для своей машины) |
| `INFERENCE_API_KEY` | пусто | ключ; пусто = модели нет, вердикт по правилам |
| `INFERENCE_MODEL` | пусто (в образце `qwen3.8-27b`) | модель, выбрана замером (спека 008, 8) |
| `INFERENCE_VISION` | пусто | `1` = модель видит и скриншот страницы |
| `AGENT_MODEL` | пусто | `off` = модель выключена, что бы ни было задано выше |
| `AGENT_MODEL_THINKING` | пусто | `default` = модели с рассуждением рассуждают (тратят токены); иначе им говорят не рассуждать |
| `AGENT_MODEL_TIMEOUT_S` | 30 (1–300) | срок одного запроса |
| `AGENT_MODEL_MAX_TOKENS` | 2000 (200–16000) | предел ответа |
| `AGENT_MODEL_RETRIES` | 2 (0–5) | повторы при сбое |
| `AGENT_MODEL_CONCURRENCY` | 8 (1–16) | запросов к модели одновременно |
| `AGENT_DAILY_REQUESTS` | 2000 | суточный бюджет запросов всего сервиса; дальше вердикт по правилам |
| `AGENT_DAILY_TOKENS` | 4000000 | суточный бюджет токенов |
| `AGENT_MAX_STEPS` | 5 (0–20) | действий агента в одной глубокой проверке |

### Служба
| Переменная | По умолчанию | Что делает |
|---|---|---|
| `WEB_PORT` | 8080 | порт на `127.0.0.1` (снаружи только через Caddy) |
| `WEB_DATA_DIR` | `/var/lib/zerostress-web/tasks` | готовые отчёты (24 часа) |
| `WEB_CLIENT_DIR` | `../client/dist` рядом с `server/` (как установлено) | собранный клиент; в рабочей копии `build/client` |
| `SUP_SOCKET` | `/run/zerostress/supervisor.sock` | сокет супервизора |
| `WEB_DEMOS` | `A harmless page\|https://example.com/` | кнопки-примеры под полем ввода, `подпись\|адрес;подпись\|адрес` |
| `GEO_DIR` | `/var/lib/zerostress-web/geo` | таблицы DB-IP Lite; без них страны не называются |
| `WEB_RDAP` | пусто | `off` = возраст домена не запрашивается |

### Лимиты (спека 007, 5)
| Переменная | По умолчанию | Что ограничивает |
|---|---|---|
| `WEB_LIMIT_PER_HOUR` | 5 | новых проверок с одного адреса в час |
| `WEB_LIMIT_PER_DAY` | 20 | в сутки |
| `WEB_LIMIT_ACTIVE` | 1 | идущих одновременно с одного адреса |
| `WEB_LIMIT_STREAMS` | 4 | открытых потоков хода проверки с одного адреса |
| `WEB_LIMIT_DAILY_CAP` | 300 | проверок в сутки на весь сервис |
| `WEB_LIMIT_CHAT_PER_HOUR` | 20 | обращений к чату с одного адреса в час |
| `WEB_LIMIT_CHAT_PER_REPORT` | 12 | вопросов по одному отчёту |

## supervisor.env
Значения вне диапазона супервизор отвергает при старте (`supervisor/config.go`).

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `SUP_CONCURRENCY` | 2 (1–4; в образце 2) | микро-ВМ одновременно; 2 выбрано замером (спека 006) |
| `SUP_QUEUE_MAX` | 20 | длина очереди |
| `SUP_QUEUE_WAIT_S` | 120 | сколько задача ждёт в очереди |
| `SUP_BOOT_TIMEOUT_S` | 15 | срок загрузки ВМ |
| `SUP_HARD_TIMEOUT_S` | 90 | общий срок обычной проверки |
| `SUP_VCPU` | 2 (1–4) | процессоров на ВМ |
| `SUP_MEM_MIB` | 1024 (256–4096) | памяти на ВМ |
| `SUP_MIN_FREE_GB` | 20 | меньше свободного места на диске — новые запуски не принимаются |
| `SUP_RESULT_TTL_H` | 24 | сколько хранятся итоги запусков |
| `SUP_SESSION_SLOTS` | 1 (0–4) | живых сессий (глубоких проверок) одновременно; 0 = выключены |
| `SUP_SESSION_IDLE_S` | 60 | закрыть сессию после простоя (пока команда ждёт человека, часы стоят) |
| `SUP_SESSION_MAX_S` | 300 | предел жизни сессии |
| `SUP_SESSION_GRACE_S` | 30 | время на закрытие сессии |
| `SUP_APPROVAL_TTL_S` | 300 | сколько рискованная команда ждёт решения человека |
| `SUP_COMMAND_MAX` | 190 | команд в одном запуске |
| `SUP_COMMAND_TIMEOUT_S` | 30 | срок одной команды |
