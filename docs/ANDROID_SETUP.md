# Установленное Android-приложение

## 1. Хост

Практичный вариант для AVD — выделенный Linux x86_64 с доступным KVM. Сначала проверьте запуск одного эмулятора. Размер сервера выбирайте по измерениям конкретного приложения; скрипт выделяет AVD 3072 MB RAM, дополнительно нужна память ОС и Appium. Обычный контейнер без доступа к виртуализации не заменяет такой хост.

Установите Node.js 24, JDK, Android SDK Command-line Tools, Platform Tools, Emulator и системный образ с Google Play. Пример путей:

```bash
export ANDROID_HOME=/opt/android-sdk
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

sdkmanager --licenses
sdkmanager 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0' 'emulator' 'system-images;android-35;google_apis_playstore;x86_64'
emulator -accel-check
```

Пути должны соответствовать вашей установке. Принятие лицензий выполняется вами. На ARM нужен совместимый образ и корректное значение `ANDROID_SYSTEM_IMAGE`.

Установите Appium с UiAutomator2 под отдельным сервисным пользователем, который владеет SDK, AVD и USB-устройствами. Зафиксируйте версии в своей инфраструктуре; версия пакетов, доступная при подготовке проекта:

```bash
npm install -g appium@3.7.0
appium driver install --source=npm appium-uiautomator2-driver@8.7.0
appium driver doctor uiautomator2
appium --address 127.0.0.1 --port 4723 --log-level warn
```

Не включайте `--relaxed-security`. Appium, ADB, порты эмуляторов и UiAutomator2 доступны только с доверенного хоста. Подробные HTTP-логи Appium способны содержать ввод; не включайте debug/логирование тел запросов при входе кассира.

## 2. Создание компании и Android

Первый раз запустите сервис в sandbox, создайте компанию и скопируйте её UUID. Затем остановите API (`Ctrl+C`). Для реальных операций используйте отдельный `DATA_DIR` и создайте компании заново в режиме Android, чтобы не смешивать тестовые и реальные платежи. В новом Android-режиме компания создаётся через кабинет и пока остаётся неподключённой.

Укажите в `.env`:

```dotenv
DRIVER_MODE=android
LIVE_AUTOMATION_ENABLED=false
DATA_DIR=./data-live
APPIUM_URL=http://127.0.0.1:4723
CONNECTOR_CONFIG=./config/android.live.json
ANDROID_HOME=/opt/android-sdk
JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
ANDROID_SYSTEM_IMAGE=system-images;android-35;google_apis_playstore;x86_64
```

Запустите API, создайте нужную компанию и снова остановите API перед привязкой:

```bash
npm run android -- create MERCHANT_UUID 5554 8200
npm run android -- start MERCHANT_UUID
```

`start` остаётся работающим процессом. Во втором терминале:

```bash
npm run android -- devices
npm run android -- install MERCHANT_UUID /absolute/path/original-kaspi-pay.apk
```

Используйте оригинальную установку из доверенного источника. APK не модифицируется и не включён в проект. Для split APK используйте предусмотренную Android установку `adb install-multiple`; затем проверьте полный пакет на устройстве.

Следующей компании нужны другой AVD и порты, например `5556` / `8201`. Скрипт создаёт **чистый экземпляр Android**, а не копию уже авторизованного аккаунта. Данные AVD лежат под `DATA_DIR/avd`.

Если Kaspi Pay не работает на эмуляторе, подключите отдельный физический Android, включите USB Debugging, подтвердите хост на устройстве и выполните:

```bash
npm run android -- devices
npm run android -- bind MERCHANT_UUID SERIAL_FROM_ADB 8200
```

Автоматическое восстановление AVD/USB-подключения организуйте системным supervisor. Пример unit для эмулятора — `ops/cashier-android@.service`. В нём нужно заменить пути, пользователя и UUID.

## 3. Вход кассира внутри приложения

Скопируйте `config/android.kaspi.example.json` в `config/android.live.json`. Укажите **наблюдаемые** `app_package` и `app_activity`; их нельзя угадывать. Имя пакета проверяется через `adb shell pm list packages`, activity — через `adb shell cmd package resolve-activity --brief PACKAGE_NAME` или Appium Inspector. Не копируйте пакет из случайного примера.

Для ручного просмотра достаточно корректных package/activity, даже пока `verified: false` и отправка реальных счетов отключена. Запустите API, откройте компанию → «Открыть Android». Это переводит компанию в ручной режим. Войдите через экран устройства; при необходимости вводите SMS в выбранное поле. Кнопка «Ввести на Android» отправляет текст только в текущий активный элемент. Самый прямой способ входа — окно AVD или физический экран устройства.

Если защищённый экран возвращает чёрное изображение или поле недоступно UiAutomator2, выполните вход непосредственно на устройстве. Защита не отключается. Автоматизация может оказаться несовместимой с такими экранами.

## 4. Подключение автоматических операций

Настройте сценарии из [CONNECTOR.md](CONNECTOR.md). Только после проверки сценариев поставьте `verified: true` и `LIVE_AUTOMATION_ENABLED=true`. Перезапустите API и в панели Android нажмите «Проверить кассира и запустить». Коннектор проверит точное название компании на экране.

Альтернативно, при остановленном API:

```bash
npm run connect -- MERCHANT_UUID
npm start
```

`connect` просит подтвердить, что вход уже выполнен в Android; пароли и SMS в терминале не запрашиваются. Во время автоматической работы не используйте этот же экземпляр приложения вручную.

## 5. Docker и Android

Для sandbox: `docker compose up --build`. Сначала выполните `npm run init`, чтобы создать `.env` и каталог `data`; задайте `LOCAL_UID`/`LOCAL_GID` равными владельцу данных.

Для Android на Linux: Appium и эмуляторы запускаются **на хосте**, затем `docker compose -f compose.android.yaml up --build`. Compose использует сеть хоста для доступа к loopback Appium. Пути `DATA_DIR` и bind mount должны указывать на одни и те же данные; при `./data-live` замените `./data:/app/data` на `./data-live:/app/data`.

CLI обслуживания запускайте после остановки API-контейнера; файл `server.lock` защищает от конкурирующего обслуживания. Не запускайте хостовый и контейнерный API на одной БД одновременно.

## Официальные источники

- [Appium: UiAutomator2 и подготовка устройства](https://appium.io/docs/en/latest/quickstart/uiauto2-driver/)
- [UiAutomator2: параметры устройства и сессии](https://github.com/appium/appium-uiautomator2-driver)
- [Android: запуск эмулятора](https://developer.android.com/studio/run/emulator-commandline)
- [Android: ускорение эмулятора](https://developer.android.com/studio/run/emulator-acceleration)
