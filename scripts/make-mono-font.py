# Builds src/assets/fonts/RecursiveMono.woff2, the code and terminal font.
#
# Recursive's MONO axis makes it monospaced, but xterm.js measures text on a
# canvas, which ignores font-variation-settings. So the monospace style is
# baked into a font of its own: Recursive's "Mono Linear" style with only the
# weight left variable, renamed "Recursive Mono" (the OFL allows this, as
# Recursive has no Reserved Font Name), subset for code and terminals.
#
#   pip install fonttools brotli
#   curl -LO https://github.com/arrowtype/recursive/releases/download/v1.085/ArrowType-Recursive-1.085.zip
#   unzip ArrowType-Recursive-1.085.zip
#   python3 scripts/make-mono-font.py ArrowType-Recursive-1.085/Recursive_Desktop/Recursive_VF_1.085.ttf src/assets/fonts/RecursiveMono.woff2
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

src, out = sys.argv[1], sys.argv[2]
font = TTFont(src)
font = instancer.instantiateVariableFont(font, {'MONO': 1, 'CASL': 0, 'slnt': 0, 'CRSV': 0.5, 'wght': (300, 900)})

name = font['name']
for record in list(name.names):
    if record.nameID in (1, 16):
        record.string = 'Recursive Mono'
    elif record.nameID in (4,):
        record.string = 'Recursive Mono'
    elif record.nameID == 6:
        record.string = 'RecursiveMono'

import io
buffer = io.BytesIO()
font.save(buffer)
buffer.seek(0)
font = TTFont(buffer, lazy=False)

options = subset.Options()
options.flavor = 'woff2'
options.layout_features = ['kern', 'mark', 'mkmk', 'ccmp', 'locl']
options.name_IDs = ['*']
options.name_languages = ['*']
options.notdef_outline = True
unicodes = list(range(0x20, 0x7F)) + list(range(0xA0, 0x250)) + list(range(0x2000, 0x2070)) + list(range(0x20A0, 0x20C1)) + list(range(0x2190, 0x2200)) + list(range(0x2200, 0x2300)) + list(range(0x25A0, 0x2600)) + [0x2122, 0xFFFD]
sub = subset.Subsetter(options)
sub.populate(unicodes=unicodes)
sub.subset(font)
font.flavor = 'woff2'
font.save(out)
cmap = font.getBestCmap()
print('glyphs', len(font.getGlyphOrder()), 'chars', len(cmap), 'W advance', font['hmtx']['W' if 'W' in font.getGlyphOrder() else cmap[ord('W')]][0], 'upm', font['head'].unitsPerEm)
print('axes', [(a.axisTag, a.minValue, a.maxValue) for a in font['fvar'].axes])
