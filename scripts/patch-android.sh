#!/usr/bin/env bash
# يتشغل بعد: npx cap add android
set -e
M=android/app/src/main/AndroidManifest.xml

# 1) منع النسخ الاحتياطي التلقائي لبيانات التطبيق
sed -i 's/android:allowBackup="true"/android:allowBackup="false"/' "$M"

# 2) صلاحيات الإشعارات المجدولة
if ! grep -q "POST_NOTIFICATIONS" "$M"; then
  sed -i 's#<application#<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n    <uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />\n    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />\n    <application#' "$M"
fi

echo "Manifest patched:"
grep -n "allowBackup\|POST_NOTIFICATIONS\|SCHEDULE_EXACT_ALARM\|RECEIVE_BOOT_COMPLETED" "$M"
