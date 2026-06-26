# Sathya Messenger — Setup

## 1. Install Node.js
https://nodejs.org → download LTS → install

## 2. Install dependencies
Open terminal in this folder:
```
npm install
```

## 3. SMS Gateway app
- Install "SMS Gateway" app on Android: https://sms-gate.app
- Open app → note the URL shown (e.g. http://192.168.1.5:8080)
- Edit server.js line 20 → change SMS_GATEWAY_URL to your phone's URL
- Username/password shown in app settings

## 4. Run
```
node server.js
```
Open browser: http://localhost:3000

## 5. Connect WhatsApp
- QR appears on screen
- Open WhatsApp → Linked Devices → Link a Device → scan QR

## Done.

## Keep Alive on VPS (PM2)

```bash
npm install -g pm2
pm2 start server.js --name sathya-messenger
pm2 startup        # auto-start on reboot
pm2 save
```

That's it. Never dies.
This is just a wapp,sms inputer combined
