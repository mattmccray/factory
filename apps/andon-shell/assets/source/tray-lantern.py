# Tray lantern on a 36x36 pixel grid (18 pt @2x). Every shape is an integer-aligned rect, so the
# PNG is pixel-exact and the SVG is the same geometry. Rects are (x, y, w, h).
import sys
from PIL import Image, ImageDraw
out = sys.argv[1]
SHELL = [  # shared by both states
    (15, 1, 6, 2), (14, 2, 2, 5), (20, 2, 2, 5),   # handle loop
    (12, 6, 12, 2),                                # neck
    (9, 8, 18, 2), (6, 10, 24, 2),                 # stepped roof
    (7, 29, 22, 2),                                # base
    (9, 31, 3, 4), (24, 31, 3, 4),                 # feet
]
BODY = (9, 12, 18, 17)                             # x 9..27, y 12..29
BANDS = [(11, 17, 14, 2), (11, 23, 14, 2)]         # filled: rib gaps, inset so the side posts stay whole
OUTLINE = [(9, 12, 2, 17), (25, 12, 2, 17), (13, 17, 10, 2), (13, 23, 10, 2)]   # sides + inset ribs
def png(rects, gaps, name, scale=1):
    im = Image.new('RGBA', (36 * scale, 36 * scale), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for x, y, w, h in rects: d.rectangle([x*scale, y*scale, (x+w)*scale-1, (y+h)*scale-1], fill=(0, 0, 0, 255))
    for x, y, w, h in gaps: d.rectangle([x*scale, y*scale, (x+w)*scale-1, (y+h)*scale-1], fill=(0, 0, 0, 0))
    im.save(f'{out}/{name}')
def svg(rects, gaps, name):
    body = ''.join(f'<rect x="{x}" y="{y}" width="{w}" height="{h}"/>' for x, y, w, h in rects)
    mask = ''
    if gaps:
        holes = ''.join(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="#000"/>' for x, y, w, h in gaps)
        mask = f'<defs><mask id="m"><rect width="36" height="36" fill="#fff"/>{holes}</mask></defs>'
        body = f'<g mask="url(#m)">{body}</g>'
    open(f'{out}/{name}', 'w').write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="36" height="36" shape-rendering="crispEdges">{mask}{body}</svg>\n')
idle, running = SHELL + OUTLINE, SHELL + [BODY]
for s in (1, 8):
    sfx = '' if s == 1 else '-x8'
    png(idle, [], f'tray-idle{sfx}.png', s)
    png(running, BANDS, f'tray-running{sfx}.png', s)
svg(idle, [], 'tray-idle.svg'); svg(running, BANDS, 'tray-running.svg')
# preview: both states on a light and a dark menu-bar strip, 8x
pv = Image.new('RGBA', (36*8*2 + 48, 36*8*2 + 48), (0, 0, 0, 0))
for row, bg in enumerate([(236, 236, 236, 255), (40, 40, 40, 255)]):
    for col, n in enumerate(['idle', 'running']):
        tile = Image.new('RGBA', (36*8, 36*8), bg)
        g = Image.open(f'{out}/tray-{n}-x8.png')
        ink = Image.new('RGBA', g.size, (0, 0, 0, 255) if row == 0 else (255, 255, 255, 255))
        tile.paste(ink, (0, 0), g)
        pv.paste(tile, (16 + col*(36*8+16), 16 + row*(36*8+16)))
pv.save(f'{out}/tray-review.png')
