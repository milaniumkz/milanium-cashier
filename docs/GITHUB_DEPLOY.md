# MBusiness: GitHub Actions и секреты деплоя

Пароли и ключи не сохраняются в исходники, .env.example, workflow или Git-историю.
SSH-пароль передаётся только через зашифрованный GitHub Actions Secret; пароль
оператора и ключ шифрования приложения генерируются независимо на сервере.

## Состояние

MBusiness развёрнут через GitHub Actions на предоставленном сервере Ubuntu 24.04.
Публичный кабинет: https://mbusiness.89.126.192.185.sslip.io:8443/
Документация: https://mbusiness.89.126.192.185.sslip.io:8443/docs
Панель оператора: https://mbusiness.89.126.192.185.sslip.io:8443/operator

Проверенные запуски:

- SSH inspect: https://github.com/milaniumkz/milanium-cashier/actions/runs/41441686350
- Подготовка backend: https://github.com/milaniumkz/milanium-cashier/actions/runs/41442750610
- Собственный сертификат: https://github.com/milaniumkz/milanium-cashier/actions/runs/41443224929
- Успешный deploy: https://github.com/milaniumkz/milanium-cashier/actions/runs/41443848042

Окружение mbusiness-production и SSH Secret настроены. Ключ хоста проверяется.
Все 68 unit/integration тестов и HTTP smoke test прошли в GitHub.
Внешний health после deployment проверен. Реальные банковские операции выключены,
совместимость с реальным Kaspi ещё не проверена.

Доступ интеграции к GitHub API и Actions работает, но управление Secrets через
API этой интеграции запрещено (403). SSH Secret добавлен владельцем через GitHub.
Не переносите секреты в workflow или исходники, не печатайте их в Actions logs.

Для первичной ACME-проверки добавлен только отдельный конфиг
/etc/nginx/conf.d/mbusiness-acme.conf с новым server_name. После nginx -t выполнен
плавный reload общего Nginx без его остановки. Исходные конфиги MTaxi проверены
по SHA256, его страница до/после совпала. Сайты, база и контейнеры MTaxi не менялись.
HTTPS на 8443 работает в отдельном mbusiness-proxy.service; обычные 80/443 MTaxi
остались на месте. Собственный сертификат продлевается mbusiness-tls-renew.timer;
при продлении перезагружается только собственный HTTPS-прокси.

Пароль оператора MBusiness и ENCRYPTION_KEY созданы на сервере в
/srv/mbusiness/shared/.env (0600). Получайте пароль только приватно через SSH,
не выводите конфигурацию в GitHub logs и не отправляйте её целиком в чат.

## Настройки GitHub

Репозиторий: `milaniumkz/milanium-cashier`.
Создайте environment `mbusiness-production`. По возможности включите проверку
и одобрение запуска production deployment доверенным владельцем.

В Environment secrets:

- `MBUSINESS_SSH_PASSWORD` — действующий SSH-пароль. Значение вводится в GitHub
  Settings → Environments → mbusiness-production → Environment secrets.
  Не добавляйте его в Git-файл. Альтернатива — интерактивный `gh secret set
  MBUSINESS_SSH_PASSWORD --env mbusiness-production -R milaniumkz/milanium-cashier`
  с компьютера, на котором GitHub CLI авторизован. Значение не указывайте
  параметром командной строки и не вставляйте в workflow.

Environment variables (не секреты):

| Имя | Значение |
| --- | --- |
| MBUSINESS_SSH_HOST | 89.126.192.185 |
| MBUSINESS_SSH_USER | root |
| MBUSINESS_SSH_PORT | 22 |
| MBUSINESS_SSH_FINGERPRINT | SHA256:+Tocz2KkwW2hYTRerF6SA4DwanAyaFcQa3nrl+M2dcg |
| MBUSINESS_PUBLIC_BASE_URL | Отдельный HTTPS origin, например https://mbusiness.example.kz:8443 |

Fingerprint взят из подтверждённого пользователем SSH-подключения. Workflow
сверяет отсканированный ECDSA host key с этим fingerprint и включает строгую
проверку known_hosts. При несовпадении запуск останавливается: не отключайте
проверку, проверьте ключ через консоль хостинга.

## Первый запуск: inspect

После появления workflow в основной ветке откройте Actions → MBusiness — isolated
deployment → Run workflow → operation=inspect.

Сначала выполняются проверки JavaScript, автоматические тесты и HTTP smoke test. SSH-этап
передаёт пароль только через SSHPASS в окружении runner, проверяет ключ хоста,
создаёт свой закрытый staging-каталог `/root/mbusiness-upload-RUN-ATTEMPT` и
запускает только чтение ОС, памяти, диска, портов и наличия Node/Nginx.
Никакие сервисы и файлы MTaxi не изменяются. Пароль в логи не выводится.

Если authentication failed, исправьте Secret актуальным значением. Не делайте
многократных попыток с известным неверным паролем. Если root-login по паролю
отключён, потребуется отдельный согласованный способ SSH-доступа; не меняйте
SSH-конфигурацию MTaxi вслепую.

## Подготовка без публичного домена

operation=prepare устанавливает только приватный backend на 127.0.0.1:3181,
отдельный Node.js, пользователя, конфигурацию и базу MBusiness. HTTPS-прокси
и общие сервисы MTaxi не запускаются и не меняются. PUBLIC_BASE_URL временно
равен зарезервированному https://mbusiness.invalid:8443, это не рабочая ссылка.
При дальнейшем deploy этот единственный временный адрес заменяется выбранным,
с сохранением пароля, ключа шифрования и базы. Реальные банковские операции
остаются выключенными. Домен можно передать через public_base_url при ручном
запуске workflow, без разрешения интеграции на запись environment variables.

## Deployment

Запускайте operation=deploy после успешного inspect и проверки вывода.
Нужен отдельный домен/HTTPS-порт выше 1024, DNS на предоставленный сервер и
действующий отдельный сертификат/ключ в `/etc/mbusiness/tls/fullchain.pem` и
`/etc/mbusiness/tls/privkey.pem`. Не используйте файлы/сертификаты MTaxi.
Встроенный bootstrap поддерживает Linux x86_64 и останавливается при отсутствии
нужных программ. Глобальные пакеты на сервере он не обновляет.

Workflow:

1. Проверяет исходники и тесты на GitHub runner.
2. Формирует Git-архив выбранного commit и его SHA256 без локальных .env/баз.
3. Передаёт архив через SSH со строгой проверкой ключа хоста.
4. Создаёт только `/srv/mbusiness`, пользователя mbusiness и свои systemd units.
5. Устанавливает свой Node.js 24 с проверкой официального SHA256 и свои npm
   dependencies по lockfile. Node/PM2/Docker MTaxi не используются и не меняются.
6. Генерирует новые локальные секреты приложения, создаёт отдельную SQLite-базу.
7. При обновлении делает SQLite backup и закрытую копию собственного env.
8. Запускает только mbusiness.service и свой mbusiness-proxy.service с отдельной
   Nginx-конфигурацией, PID и портом. При обычном обновлении приложения общий Nginx не перезагружается. Первичная ACME-настройка нового домена использует отдельный конфиг и плавный reload с проверкой MTaxi.
9. Проверяет локальный health, TLS и внешний HTTPS с GitHub runner.

По умолчанию backend 127.0.0.1:3181. При первом запуске занятый порт вызывает
отказ, а не остановку чужого процесса. Firewall автоматически не меняется:
разрешение только выбранного нового порта настраивается отдельно после проверки
существующих правил. Порты 80/443 и существующие сайты MTaxi не затрагиваются.

Настройки/база хранятся в `/srv/mbusiness/shared`, релизы в отдельном releases.
Банковские операции по умолчанию выключены. Операторский пароль нужно получить
приватно из конфигурации на сервере, не выводя его в Actions logs или чат.

Bootstrap выполнен на указанном сервере. Для других серверов сначала обязателен inspect и проверка занятых портов/сервисов.

## Единый учётный кабинет

Workflow также проверяет независимый PostgreSQL backend, собирает Flutter
workspace и переносит его как artifact в собственный release MBusiness.
`ops/github-accounting.sh` создаёт только `mbusiness-accounting-db`, отдельную
PostgreSQL и `mbusiness-accounting.service`. Порты 55439/3191 доступны только
на loopback. Перед миграцией выполняется свой pg_dump. Docker daemon и MTaxi
не перезапускаются. Установка глобального PostgreSQL не выполняется.
Приложение использует отдельную роль БД без superuser, ограниченные CPU/RAM.
Подробнее: [ACCOUNTING.md](ACCOUNTING.md).
