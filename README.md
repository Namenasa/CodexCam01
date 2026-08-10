# Safety Vision

เว็บตรวจจับการเคลื่อนไหวของใบหน้า แขน มือ และขา จากกล้องในเบราว์เซอร์ พร้อมคัดกรองหมวกนิรภัยจากสีบริเวณเหนือใบหน้า

> การตรวจหมวกในเวอร์ชันนี้เป็นการคัดกรองจากสี ไม่ใช่โมเดล PPE ที่ผ่านการรับรอง ห้ามใช้เป็นหลักฐานหรือสั่งการด้านความปลอดภัยโดยลำพัง

## Getting Started

ติดตั้ง dependencies และเปิดเว็บในเครื่อง:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

เปิด [http://localhost:3000](http://localhost:3000) แล้วอนุญาตให้เว็บไซต์เข้าถึงกล้อง

หน้าแอปหลักอยู่ที่ `src/app/page.tsx`

## Deploy ไป GitHub Pages

1. สร้าง repository ใหม่บน GitHub แล้ว push โค้ดนี้ไปที่ branch `main`
2. ไปที่ **Settings → Pages → Build and deployment**
3. เลือก **Source: GitHub Actions**
4. Push เข้า `main` อีกครั้ง หรือกด Run workflow ที่แท็บ **Actions**

Workflow ใน `.github/workflows/deploy-pages.yml` จะ build เป็น static site และเผยแพร่ให้เอง URL จะเป็น `https://<github-user>.github.io/<repository-name>/`

เว็บนี้ไม่มี backend และไม่บันทึกวิดีโอ จึงเหมาะกับ GitHub Pages
