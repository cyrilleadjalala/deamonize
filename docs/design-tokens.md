# Design tokens

The Studio (`src/studio/ui/app.css`) and the icon of the Kiro extension use the visual language of kiro.dev, so the tools look at home next to Kiro. This page lists what was measured, where it is used, and what was left out on purpose.

Daemonize is not affiliated with Kiro or AWS.

## How it was measured

- Source: the home page and one documentation page of kiro.dev, dark theme, 1024 px wide, on 2026-11-17.
- Values were read from the computed styles of the rendered page. Only two pages were measured: if kiro.dev changes, measure again before editing a value.

## Tokens

| Group | Values |
|---|---|
| Violet | 500 `#9147ff` (buttons), 400 `#9e61ff`, 300 `#c59eff`, 200 `#d1b6fc`, 100 `#e0ccff`, 600 `#8728e6`, 700 `#7a0ecd`, 800 `#622ab7`, 900 `#471d86` |
| Surfaces | page `#000000`, `#19161d`, `#211d25`, `#28242e`, `#352f3d`, `#4a464e`; neutral `#09090b`; hairline `#27272a` |
| Text | `#fafafa`, secondary `#c1bec6`, muted `#928d9a`, `#a1a1aa` |
| States | green `#35d482`, yellow `#f0d033`, red `#f94358`, blue `#6aa0f6`, teal `#45ccd3` |
| Code | block `#211d25`, text `#d4d4d8`, inline fill `#352f3d`, inline border `#4a464f` |
| Radii | 16, 12, 8, 6, 4 px, pill 9999 px |
| Shadows | `0 4px 12px rgba(0,0,0,.3)`, `0 12px 28px rgba(0,0,0,.45)` |
| Motion | `0.15s cubic-bezier(0.4, 0, 0.2, 1)`, only when the user has not asked for reduced motion |

In `app.css` they are the `--kiro-*` variables. The semantic variables (`--bg`, `--panel`, `--text`, `--purple`, ...) point to them, and no colour literal may appear outside `:root` (a test checks it).

## Components

| Component | Kiro | Studio |
|---|---|---|
| Primary button | violet `#9147ff`, white text, radius 16, hover: white fill, black text | `.btn-primary` |
| Outline button | white 1 px border, radius 16, same hover | `.btn`, `.btn-quiet` |
| Navigation | capitals, 13 px, weight 500 | `.main-nav a` |
| Input | radius 16 (12 in the Studio), hairline `#352f3d` | `.input` |
| Check box | 16 px, violet | `input[type="checkbox"]` |
| Card | `#19161d`, radius 16, no border | `.card`, `.panel`, `.tile`, `.state`, `.legend` |
| Inline code | `#352f3d`, border `#4a464f`, radius 4 | `code` |
| Code block | `#211d25`, `#d4d4d8`, radius 6 | `.code-block` |
| Tabs | `#27272a` tray, selected tab `#09090b`, radius 8 | `.toolbar-group` |
| Alerts | yellow `#f0d033` | `.write-note`, banners |

Not measured on the two pages, so **derived** from the tokens above: badges and chips, tables, dialogs, progress bars, the state graph and the timeline.

## Accessibility

`tests/unit/studio-ui-contrast.test.ts` keeps text at 4.5:1 or more (3:1 for the focus ring and other marks). Two choices come from it:

- Text in violet uses `#c59eff`: the Kiro link colour `#9f63ff` is below 4.5:1 on the lighter surfaces.
- White on `#9147ff` is about 4.6:1: thin margin, so no smaller text on that fill.

The `forced-colors` and `print` blocks of `app.css` are unchanged.

## The extension

- The side panels are native tree views: they follow the theme of the editor (Dark, Light, high contrast). Code there may name theme colours (`charts.green`, `charts.yellow`, `charts.red`, ...) and never a hex value. `tests/extension/static/no-hardcoded-colors.test.ts` checks it.
- `kiro-extension/media/icon.svg` is the source of `media/icon.png` (`npm run icon` in `kiro-extension/`). The Marketplace needs a PNG. The sidebar icon `daemonize.svg` stays monochrome.

## Left out on purpose

- The AWS fonts (Diatype): they belong to AWS. The system font stack is kept.
- The Kiro logo and ghost: the extension icon is an original shield.
- The Studio logo (a ghost) looks close to the Kiro one: decide whether to redraw it.
