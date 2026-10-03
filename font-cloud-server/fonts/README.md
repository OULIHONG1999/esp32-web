# 字体库

此目录放 TTF/OTF 字体文件，服务启动时自动扫描。

字体文件不进 git（体积大）。从 lvgl 工程复制：

```powershell
Copy-Item D:\WORK\treaWork\lvgl\lv_port_pc_vscode\assets\MiSans-Regular.ttf .
Copy-Item D:\WORK\treaWork\lvgl\lv_port_pc_vscode\assets\Ubuntu-Medium.ttf .
```

也可以放入任意其它 `.ttf` / `.otf`，刷新 `/api/fonts` 或 `POST /api/fonts/reload` 即可。

> 注意：中文字体请用**完整 TTF**（或含所需汉字的子集），服务端会按请求字符再裁剪。
