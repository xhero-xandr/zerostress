# Настройки

Где что настраивается и что значит каждая переменная. Решения и причины: [specs/010-layout-and-deploy.md](specs/010-layout-and-deploy.md). Тесты `web/server/test/env-example.test.ts` и `supervisor/envexample_test.go` падают, если код читает переменную, которой нет в образце или здесь.

## Где лежат
Всё под одним каталогом проекта: `/zerostress` на сервере, рабочая копия у разработчика (спека 010).

| Что | Файл | Образец (в git) | Кто читает | Секрет |
|---|---|---|---|---|
| Настройки сайта и агента | `config/web.env` | [config/web.env.example](../config/web.env.example) | служба `zerostress-web` | **да**: `INFERENCE_API_KEY` |
| Настройки ВМ и очереди | `config/supervisor.env` | [config/supervisor.env.example](../config/supervisor.env.example) | служба `zerostress-supervisor` | нет |
| Прокси | `config/Caddyfile` | [deploy/templates/Caddyfile.tmpl](../deploy/templates/Caddyfile.tmpl) | `caddy` | нет; делает `./zs install`, руками не правится |
| Версии и хеши | — | [deploy/versions.env](../deploy/versions.env) | установщик, сборка образа | нет |
| Системные файлы вне каталога (юниты, sudoers, sysctl, udev, logrotate) | `/etc/…` | [deploy/files/](../deploy/files/) | systemd, sudo, ядро | нет; ставит `./zs install`, руками не правятся |

Работа: `./zs config web` (или `supervisor`) открывает файл в редакторе и перезапускает службу; `./zs verify` сверяет имена переменных с образцом (значения не печатает). `config/*.env` в `.gitignore`. Строки без `#` в образце заданы намеренно, закомментированные показывают значение по умолчанию. Ключ модели должна читать только служба сайта, поэтому файлов два, а не один: `config/web.env` принадлежит `root:zerostress-web` с правами `0640`.

У разработчика то же самое: `cp config/web.env.example config/web.env`, вписать ключ (если нужна модель), `./zs dev`.

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
`<корень>` — каталог на два уровня выше `web/server/`: `/zerostress` на сервере, рабочая копия у разработчика.

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `WEB_PORT` | 8080 | порт на `127.0.0.1` (снаружи только через Caddy) |
| `WEB_DATA_DIR` | `<корень>/data/web/tasks` | готовые отчёты (24 часа) |
| `WEB_CLIENT_DIR` | `<корень>/build/client` | собранный клиент |
| `SUP_SOCKET` | `<корень>/run/supervisor.sock` | сокет супервизора (его же читает супервизор, см. ниже) |
| `WEB_DEMOS` | `A harmless page\|https://example.com/` | кнопки-примеры под полем ввода, `подпись\|адрес;подпись\|адрес` |
| `GEO_DIR` | `<корень>/data/geo` | таблицы DB-IP Lite; без них страны не называются |
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
| `SUP_STATE_DIR` | `/zerostress/data/supervisor` | состояние: каталоги запусков, итоги, база (помощник `zsvm` держит свой путь `…/runs` зашитым) |
| `SUP_IMAGE_DIR` | `/zerostress/images` | образ гостя |
| `SUP_KERNEL` | `<SUP_IMAGE_DIR>/vmlinux-6.18.56` | ядро гостя |
| `SUP_ZSNET` | `/zerostress/bin/zsnet` | помощник сети (через sudo) |
| `SUP_ZSVM` | `/zerostress/bin/zsvm` | помощник запуска ВМ (через sudo) |

`SUP_SOCKET` (по умолчанию `/zerostress/run/supervisor.sock`) читают обе службы: супервизор создаёт сокет, сайт к нему подключается.
