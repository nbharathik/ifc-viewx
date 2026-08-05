<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="lockup-dark.svg">
    <img src="lockup-light.svg" alt="IFCViewX" width="360">
  </picture>
</p>

## The mark

A building, drawn the way the app draws one: a single massing in isometric,
three flat tones for the roof and the two elevations, and lit windows on a two
storey grid. No gradient, no outline, no bevel. Two floors keep the silhouette
short and the whole logo down to eleven polygons, which is why it survives a
browser tab.

The wordmark sets IFCViewX as one word. IFC is muted and ViewX is solid, which
is the only cue the eye needs to parse the camel case, and it keeps the product
name reading as one thing rather than three.

Blue is the app's one accent, so the icon and the UI share a colour: `#93b9fb`
roof, `#3b82f6` lit elevation, `#1e5bd0` shaded elevation, on a `#0f1115` tile.

## Which file

| Use | File |
| --- | --- |
| README, docs, slides | `lockup-dark.svg`, `lockup-light.svg` |
| Text only, tight spaces | `wordmark-dark.svg`, `wordmark-light.svg` |
| Anywhere with its own background | `mark.svg` |
| App icon, store listing | `icon-<px>.png` (16 to 1024), `mark-tile.svg` |
| Browser tab | `favicon.svg`, `favicon.ico` |
| The app's own chrome | `embed.txt`, pasted into `index.html` |
| GitHub social preview | `banner.png` (1280x640) |
| One colour, print, stencil | `mark-mono.svg`, which inherits `currentColor` |

Pair the two lockups with `<picture>` and `prefers-color-scheme` so the wordmark
follows the reader's theme. At or below 24 px the windows drop for one storey
line per floor join, because even four windows a face turn to noise at that
size; the `.ico` carries a separately drawn image at each of its seven sizes for
the same reason. The massing never changes, so a 16 px tab icon and a 1024 px
app icon are the same building.

`embed.txt` holds the three lines `index.html` needs: the `<link rel="icon">`
data URI, and the `--mark` / `--mark-sm` custom properties that the splash, the
top bar and the dropzone all paint from. Paste it over the existing three lines
after regenerating, and every surface in the app moves together.

Give the mark clear space of at least a quarter of its width on every side, and
do not stretch, rotate, recolour or outline it. On a photo or a busy panel use
`mark-tile.svg`, not the bare mark.

## Regenerating

```
pip install pillow fonttools
python dev/make_logo.py
```

Every file above is derived from the constants at the top of
[dev/make_logo.py](../../dev/make_logo.py), so changing the storey count, the
rise or the palette re-flows the icons, the lockups and the banner together.
Glyphs are emitted as outlines, so no asset depends on a font being installed.

Bahnschrift ships with Windows. If you would rather cut the wordmark from a face
you can redistribute, point the script at it:

```
python dev/make_logo.py --font path/to/Font.ttf --axes 600,87.5
```
