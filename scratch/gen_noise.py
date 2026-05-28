import base64, random, os
from PIL import Image
from io import BytesIO

def make_noise(w, h, alpha, path):
    img = Image.new('RGBA', (w, h))
    px = img.load()
    for x in range(w):
        for y in range(h):
            v = random.randint(0, 255)
            px[x, y] = (v, v, v, alpha)
    buf = BytesIO()
    img.save(buf, format='PNG')
    b64 = 'url("data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode() + '")'
    with open(path, 'w') as f:
        f.write(b64)

os.makedirs('scratch', exist_ok=True)
make_noise(100, 100, int(255*0.03), 'scratch/noise1.txt')
make_noise(100, 100, 255, 'scratch/noise2.txt')
print('done')
