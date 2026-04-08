# تعليمات رفع التطبيق على GitHub Pages

## المشاكل اللي تم حلها
1. **الشعارات مكسورة** — كانت تستخدم مسارات مطلقة (`/img/kfaa-logo.png`). تم تحويلها إلى base64 مدمج داخل HTML
2. **تسجيل الدخول يعلق** — ملف JavaScript الرئيسي (`app.v5c.js`) ما كان يتحمل بسبب المسارات المطلقة. تم تحويل كل المسارات لنسبية
3. **Service Worker** — مسار التسجيل تم تصحيحه
4. **manifest.json** — `start_url` تم تغييره من `/` إلى `.`

## التغييرات التفصيلية
| الملف | التغيير |
|-------|---------|
| `index.html` | شعارات KFAA و BAE تم تحويلها لـ base64 |
| `index.html` | `src="/app.v5c.js"` → `src="app.v5c.js"` |
| `index.html` | `src="/tesseract/tesseract.min.js"` → `src="tesseract/tesseract.min.js"` |
| `index.html` | `src="/lib/xlsx.full.min.js"` → `src="lib/xlsx.full.min.js"` |
| `index.html` | `href="/manifest.json"` → `href="manifest.json"` |
| `index.html` | `register('/sw.js')` → `register('sw.js')` |
| `manifest.json` | `"start_url": "/"` → `"start_url": "."` |

## خطوات الرفع على GitHub Pages

### الطريقة 1: مستودع جديد (الأسهل)
1. أنشئ مستودع جديد على GitHub (مثلاً `library-app`)
2. ارفع **كل الملفات** الموجودة هنا مباشرة في جذر المستودع (بدون مجلد فرعي)
3. اذهب إلى **Settings → Pages**
4. اختر **Source: Deploy from a branch**
5. اختر **Branch: main** و **Folder: / (root)**
6. اضغط **Save**
7. انتظر دقيقة أو دقيقتين
8. التطبيق سيكون على: `https://اسمك.github.io/library-app/`

### الطريقة 2: تحديث المستودع الحالي
1. احذف كل الملفات القديمة في المستودع
2. ارفع الملفات الجديدة من هذا المجلد مباشرة في الجذر
3. تأكد إن `index.html` موجود في جذر المستودع (مو داخل مجلد فرعي)
4. GitHub Pages يقرأ `index.html` من الجذر تلقائياً

### هيكل الملفات المطلوب:
```
المستودع/
├── index.html          ← الملف الرئيسي
├── app.v5c.js          ← كود JavaScript
├── manifest.json       ← إعدادات PWA
├── sw.js               ← Service Worker
├── _headers            ← هيدرات (اختياري)
├── lib/
│   └── xlsx.full.min.js
└── tesseract/
    ├── tesseract.min.js
    ├── worker.min.js
    ├── ara.traineddata.gz
    ├── eng.traineddata.gz
    └── tesseract-core-*.wasm*
```

## ملاحظات مهمة
- **لا تغير أسماء الملفات** — الكود يعتمد على الأسماء الحالية
- **مجلد `img/` ما يحتاجه** — الشعارات مدمجة داخل HTML كـ base64
- **التطبيق يشتغل أوفلاين** بعد أول تحميل (PWA)
- **Supabase والتزامن** يشتغلون عادي — ما فيه أي تغيير بالوظائف
- **الملفات نفسها تشتغل على Netlify أيضاً** — متوافقة مع الاستضافتين
