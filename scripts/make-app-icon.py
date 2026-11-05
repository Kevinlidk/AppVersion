"""生成桌面端(打包用)应用图标 desktop/app-icon.png。

设计直接沿用 public/favicon.svg 的几何结构(纸箱 + 封箱带 + 蓝色勾选标),
放大到 1024×1024 并用 4 倍超采样保证边缘平滑 —— Pake/Tauri 要求 ≥512px。

用法: python scripts/make-app-icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

SCALE = 4          # 超采样倍数
SIZE = 1024        # 最终尺寸
C = SIZE * SCALE   # 画布尺寸

# 原始 favicon 是 64×64 坐标系
u = C / 64.0


def px(v):
    return v * u


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


img = Image.new("RGBA", (C, C), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# 底板(圆角矩形 #f4f6fb)
draw.rounded_rectangle([0, 0, C - 1, C - 1], radius=px(14), fill="#f4f6fb")

# 箱体:y 26→55,x 10→54,底部圆角 3 —— 用纵向渐变逐行绘制
body_top, body_bot = px(26), px(55)
body_x0, body_x1 = px(10), px(54)
radius = px(3)
for y in range(int(body_top), int(body_bot) + 1):
    t = (y - body_top) / max(1.0, body_bot - body_top)
    color = lerp((0xE8, 0xB8, 0x78), (0xC9, 0x8A, 0x4B), t)
    # 底部圆角:接近底部时两侧内缩
    inset = 0.0
    if y > body_bot - radius:
        dy = (y - (body_bot - radius)) / radius
        inset = radius * (1 - (1 - dy * dy) ** 0.5)
    draw.line([(body_x0 + inset, y), (body_x1 - inset, y)], fill=color)

# 箱盖:y 15→26,x 13→51(左上/右上圆角 3)
lid_top, lid_bot = px(15), px(26)
lid_x0, lid_x1 = px(13), px(51)
lid_radius = px(3)
for y in range(int(lid_top), int(lid_bot) + 1):
    t = (y - lid_top) / max(1.0, lid_bot - lid_top)
    color = lerp((0xD7, 0x9A, 0x5C), (0xB0, 0x74, 0x3C), t)
    inset = 0.0
    if y < lid_top + lid_radius:
        dy = (y - lid_top) / lid_radius
        inset = lid_radius * (1 - (1 - (1 - dy) ** 2) ** 0.5) if dy < 1 else 0
    draw.line([(lid_x0 + inset, y), (lid_x1 - inset, y)], fill=color)

# 封箱带(竖向白色半透明,盖住箱体与箱盖之间的接缝)
draw.rectangle([px(27), px(15), px(37), px(55)], fill=(0xF4, 0xF6, 0xFB, 235))

# 蓝色勾选圆标
cx, cy, r = px(46), px(44), px(11)
draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill="#2563eb")

# 白色对勾(M40.5 44.2 l3.6 3.6 l7.2-7.4),按线宽 3 描边
stroke = px(3)
pts = [(px(40.5), px(44.2)), (px(44.1), px(47.8)), (px(51.3), px(40.4))]
draw.line(pts, fill="#ffffff", width=int(stroke), joint="curve")
for p in (pts[0], pts[-1]):          # 圆头端点
    draw.ellipse([p[0] - stroke / 2, p[1] - stroke / 2, p[0] + stroke / 2, p[1] + stroke / 2],
                 fill="#ffffff")

out = img.resize((SIZE, SIZE), Image.LANCZOS)
target = Path(__file__).resolve().parent.parent / "desktop" / "app-icon.png"
target.parent.mkdir(parents=True, exist_ok=True)
out.save(target, "PNG", optimize=True)
print(f"已生成 {target} ({out.size[0]}×{out.size[1]}, {target.stat().st_size} bytes)")
