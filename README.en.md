# Paint Pro · Drawing and Pixel Art Workbench

[简体中文](README.md) | **English**

Paint Pro is a browser-based image editor and pixel art tool with eight modes: pixel conversion, drawing, retouching, composition, tile canvas, slicing, pixel optimization, and transparent padding. All modes share an asset workspace, so results can be used in the next editing step.

The app uses native JavaScript ES modules, Canvas 2D, Web Workers, and IndexedDB. Images are processed in your browser; the application code does not upload user images to a server. No frontend dependency installation, external fonts, or build step is required.

## Launch the application

Application files are in `dist`. Install **Python 3** first. There is no need to install npm dependencies or build the app.

### Windows

Double-click **`dist/start.bat`**, keep the command window open, and visit <http://127.0.0.1:8080> in your browser. The launcher checks `py -3`, `python`, and `python3`, in that order, and uses an available Python 3 interpreter.

You can also run it from the repository root and optionally specify a port:

```powershell
.\dist\start.bat
# Use another port if 8080 is already in use:
.\dist\start.bat 8090
```

### macOS / Linux

Run from the repository root:

```sh
sh ./dist/start.sh
# Optional: choose another port
sh ./dist/start.sh 8090
```

Both scripts serve their own application directory, including when invoked from another working directory. By default, they listen only on `127.0.0.1:8080`. If you choose another port, open the corresponding address. Press **Ctrl+C** to stop the server.

### Manual startup and deployment

Alternatively, start a static server from the repository root:

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory dist
```

On Windows, replace `python3` with `py -3` or `python` as needed. ES modules and Workers must be served over HTTP/HTTPS; opening the HTML directly with `file://` will not work. For directory read/write access, use desktop Edge or Chrome and grant access to a working directory inside the app.

For static hosting, use `dist` as the site root and upload its complete HTML, JavaScript, CSS, and icon files. The Sites configuration in `.openai/hosting.json` already points to `dist`.

## Eight working modes

The default navigation order is **Pixel Conversion → Drawing → Retouching → Composition → Tile Canvas → Slicing → Pixel Optimization → Transparent Padding**.

Hold a mode entry for about 0.4 seconds, drag it over another entry, and release to swap their positions. Press Escape, release outside the navigation, or move focus away from the window to cancel. Narrow screens support horizontal scrolling and edge scrolling while dragging. With a mode entry focused, use **Alt + Left / Right** to swap adjacent entries. The order is saved as a browser preference; new modes are appended to an existing custom order.

| Mode | Main features | Workspace integration |
| --- | --- | --- |
| **Pixel Conversion** | Pixelation, color reduction, three sampling methods, output scaling, transparency, comparisons, PNG/SVG export | Reads visible layers; saves new editable assets or batch results as ZIP |
| **Drawing** | Document tabs, layers, whole-layer movement, text, shapes, selections, cropping, transforms, fill, shared guides | Each asset has its own layers and editing history |
| **Retouching** | Brightness, contrast, saturation, hue, blur, presets, sharpening, pixel inspection, navigator, history | Previews adjustments before applying them to the active layer |
| **Composition** | Free image placement, slot-based assembly, multiselection, scaling, rotation, flipping, alignment, automatic layout | Uses workspace assets and can send a layered result back to drawing |
| **Tile Canvas** | Fixed dimensions, HD presets, movement and rotation, pixel-sized tiles, grid snapping, point measurement, PNG/ZIP export | Saves an independent scene; reuses assets and slots; can return layers to drawing |
| **Slicing** | Draggable cut lines, exact coordinates, equal divisions, previews, sprite-sheet rows/columns, optional transparent padding | Creates independent assets from a snapshot of the source's visible layers |
| **Pixel Optimization** | Grid detection and offsets, sampling, color reduction, transparent edges, isolated-pixel cleanup, comparisons, integer-scale export | Applies a result layer, creates new assets, or processes existing assets in batches |
| **Transparent Padding** | Aspect ratios, canvas multipliers, target sizes, automatic content centering, five resize algorithms | Processes all layers of one asset or the workspace; supports copies and transparent PNG export |

## Getting started

1. Open a working directory, import images, or drag images into the app. Select the current image in the asset list or document tabs.
2. To create a pixel-art look, use Pixel Conversion, compare the result, and save a new asset to continue drawing.
3. Edit in Drawing. Each image keeps its layers, view position, and session history. Switching or closing images preserves the current zoom; use Fit to Window or 1:1 to reset the view.
4. Use Retouching for active-layer adjustments. Sliders produce temporary previews; Apply commits the change. Resetting, changing the target, or leaving the relevant panel/mode cancels an unapplied preview.
5. Arrange assets in Composition, or connect parts using slots. Send the result to Drawing for layered editing.
6. Set canvas and tile dimensions in Tile Canvas, place assets, measure grid points, and export a full PNG or a ZIP of tiles.
7. In Slicing, position cut lines or enter sprite-sheet rows and columns. Confirm to add the complete set of slices to the workspace.
8. Compare results in Pixel Optimization, then apply to the current asset, process the workspace, create a new asset, or export PNG.
9. Use Transparent Padding to add transparent space or resize images. Preview before applying to the current asset or workspace, creating a copy, or exporting PNG.
10. Export images for final output and save a **`.paintspace` workspace project** to preserve editable data.

## Canvas display and appearance

Drawing, Retouching, and Transparent Padding share background settings, including a dark checkerboard using `#252B33` and `#3A424D`. Backgrounds are saved with drafts and projects but do not alter transparency or exported pixels.

Drawing and Retouching provide a grid toggle and integer spacing from **1–1024 px**, defaulting to 1 px with the grid hidden. When grid spacing would be less than 5 screen pixels, the grid is temporarily hidden and the required zoom is shown. Grids and other guides are never included in image exports.

The appearance menu offers System, Light, and Dark themes. Theme preferences are saved separately from projects. Navigation, toolbars, and small floating controls use a Liquid Glass appearance; asset and settings panels use solid surfaces. Images, palettes, and pixel previews retain their actual colors.

Simplified effects disable motion and use solid surfaces. System accessibility preferences take priority. Effects adapt to device performance and browser support. The implementation uses CSS gradients, shadows, and `backdrop-filter`; it does not require WebGL. The appearance menu supports arrow keys, Home/End, Enter/Space, and Escape.

## Drawing, retouching, and layer movement

- Pencil, nine brush styles, eraser, tolerance fill, eyedropper, foreground/background colors, and HEX/RGB/HSV editing.
- Text and font styles, 24 shapes, outlines and fills, polygons, and curves.
- Rectangular/freehand selections, moving and resizing, cut/copy/paste, transparent selection, inversion, and cropping.
- Image/canvas resizing, percentage sizing, aspect-ratio locking, resampling, rotation, flipping, skewing, and color inversion.
- Layer creation, duplication, deletion, renaming, ordering, merging, visibility, locking, opacity, and eight blend modes.
- Rulers, panning, actual-size and fit views, configurable grids, an 11×11 pixel inspector, navigator, and history navigation.
- Active-layer color adjustments, presets, and sharpening that preserves pixel alpha. The brightness distribution is a sampled preview rather than an exact full-image histogram.

Select a layer and use **V** or the layer-move button to drag its pixels without making a selection. Optional canvas layer picking, or Ctrl/Cmd-click, selects the top visible nontransparent layer. Locked layers are selected with an unlock prompt.

Movement uses integer pixels; Shift constrains dragging to an axis. Arrow keys move 1 px, or 10 px with Shift. By default, pixels outside the canvas are discarded when a move is committed; undo restores them. Enable the keep-content-inside option to protect edges. A drag commits one history step. Escape, focus loss, pointer cancellation, or switching documents/layers/tools/modes cancels an unfinished drag.

Canvas edge and corner handles resize the frame without scaling pixels. Expansion adds transparency; contraction crops all layers, including hidden and locked layers. A release commits one undoable change. Focused handles support 1 px arrow-key steps, or 10 px with Shift. Handles are hidden during conflicting selection, region-capture, or pan operations.

## Pixel conversion

Conversion always starts from a snapshot of the selected asset's visible layers, rather than repeatedly processing the previous result.

| Setting | Range and behavior |
| --- | --- |
| Pixel block size | 2–32 px; default 8 px |
| Maximum colors | 2–256; default 128; the actual RGB count is displayed |
| Output scale | 10–100%; scaling happens before block sampling |
| Sampling | Dominant color, average, or median |
| Grid alignment | Enabled by default; extends output dimensions to whole blocks; disabling it preserves scaled dimensions |
| Preserve transparency | Enabled by default; fully transparent pixels do not contribute RGB samples and partial alpha is weighted; disabling it composites on white |

Compare the source and result, view either one alone, zoom, pan, and use a preview grid. PNG and SVG exports use the same block geometry. SVG uses rectangles with transparency and combines adjacent identical blocks within a row.

Save as a new workspace asset while keeping the source selected, or save and open the result in Drawing. Batch conversion freezes the initial asset list and settings, then creates assets or exports PNG/SVG ZIP files. Newly created assets do not reenter the queue. Stopping preserves completed assets; changed or closed sources are skipped.

Scaled input is limited to **16,777,216 pixels** per image. SVG output supports up to **100,000 merged rectangles**. Conversion settings are saved with projects and drafts; save a result as an asset to retain its pixels.

## Slicing and sprite sheets

Slicing reads the selected asset's visible-layer composite and leaves the source unchanged. Results are independent, single-layer PNG assets; preview rulers, lines, labels, and selections are not exported.

- **Free cut lines:** up to 40 horizontal and 40 vertical lines. Drag or enter integer coordinates; add a line in the largest gap, remove lines, distribute evenly, or clear all lines. Actual cuts use rounded integer boundaries. Duplicate lines and edge lines do not create empty slices.
- **Sprite sheets:** enter 1–100 rows and columns, each no larger than the corresponding source dimension. For example, a 1024×512 image with 4 rows and 8 columns produces 32 frames of 128×128 px.
- **Nondivisible dimensions:** enable transparent-edge padding to use `ceil(width / columns)` and `ceil(height / rows)`, extending the right and bottom edges without rescaling. Fully transparent final frames are retained in order.
- **Confirmation:** the entire set is built before it is added. The source remains selected; new assets have unique names and independent history. Cancellation, invalid parameters, source changes, or capacity errors do not add a partial set.

The workspace supports **100 assets**. Adding slices checks the combined layer budget of **64 Mi pixels**; a source is limited to 8192 px per side and 32 Mi pixels in area. Previews can calculate larger sets, but only the first 100 thumbnails are shown and confirmation requires sufficient capacity. Slice settings are saved in projects and drafts.

## Fixed tile canvas and measurement

Start with a transparent **1920×1080** canvas, choose 1280×720 or 2560×1440, or enter custom dimensions. Changing the frame preserves asset sizes and scene content outside the output boundary. Empty canvases can also be saved or exported.

- Move with **V**, multiselect with Shift, and enter precise X/Y values. New assets enter move mode automatically.
- Rotate with **R**, horizontal dragging, the rotation handle, or numeric input. Shift snaps to 15°; −90°, +90°, and reset controls are available. Attached parts follow their slot constraints.
- Tiles default to **64×64 px**, with square presets and custom rectangular sizes. Snap an asset's top-left, bottom-left, or center to grid intersections. Alt temporarily disables snapping; valid slot targets take priority when enabled.
- Use **M** to choose two grid points and inspect pixel coordinates, width/height, and row/column spans. A third click starts a new measurement. Measurements are temporary view aids and are not exported or saved as scene history.
- Export a full PNG or send separate layers to Drawing at the fixed canvas size. The original tile scene remains editable.
- Tile ZIP export includes PNG files and **`layout.json`**. Partial edge tiles can be padded to full size or retain their actual dimensions. Fully transparent tiles may be skipped; row-major names such as `tile_r000_c000.png` keep their original indices.

Canvas and tile dimensions accept integers from **1–8192 px**, with a maximum area of **32×1024×1024 pixels** each. A ZIP is limited to **10,000 tiles** and **200 MiB**. Export freezes a snapshot, shows progress, and supports cancellation. Scene settings, layers, and slots are saved with projects and drafts.

## Slot-based composition

Select a body layer and edit up to **six named slots** in original-image coordinates. A part uses its center as the default docking point; edit that point when a different attachment location is needed.

With slot snapping enabled, drag a part within 22 screen pixels of an empty slot, or select a body/slot in the panel. Each slot accepts one part. Replacing an occupied slot disconnects the previous part while preserving its world position; locked parts must be unlocked first.

Body movement, scaling, rotation, and flipping keep connected anchors aligned. Parts retain independent size, angle, and flipping. Nested connections are supported; cycles are rejected. Dragging or changing the position of a connected part disconnects it, with optional reconnection on release. Alt temporarily disables snapping.

Select an entire assembly to move or duplicate it with its connections. Disconnecting, replacing a part, or deleting a body/slot preserves the remaining parts' positions. Anchor edits are committed only when saved. Connections and scene edits support undo/redo and project/draft persistence; exported images contain only asset pixels.

## Transparent padding and image resizing

Padding finds the bounding box of all visible pixels with **alpha > 0**, including semitransparent edges, and centers that content. Fully transparent assets use the canvas center. Padding moves original pixels by integer offsets without scaling or removing existing canvas content. All layers receive the same offset while retaining their properties.

Choose a preset/custom aspect ratio, a canvas multiplier, or exact target dimensions. HD dimension presets are available. Batch processing can calculate a common output size or use each asset's own dimensions and content center. An insufficient exact target size produces an error. Previews always use the input snapshot; repeated parameter changes do not accumulate padding. Completed batch items have individual undo history.

Use **Image Resize** to scale pixels instead. Output dimensions must be integers from **1–8192 px**, within **32×1024×1024 pixels**, and fit the workspace layer budget.

| Size mode | Behavior |
| --- | --- |
| Dimensions | Default 48×48; independent width and height; square presets from 16 to 256 |
| Percentage | 0.1–3200%; default 100%; calculated from each source's dimensions |
| Fixed width / fixed height | Calculates the other dimension proportionally |
| Fixed long edge | Sets the longer side and calculates the other proportionally; default 256 px |

Exact dimensions support **stretch**, **contain** with centered transparency, **cover** with centered cropping, and **inside** to fit a bounding box without padding. Other size modes produce proportional dimensions directly. Calculations include the entire source canvas and existing transparent margins. Proportional sizes use ties-to-even rounding, with a minimum of 1 px; an odd padding remainder goes on the right or bottom.

| Algorithm | Typical behavior |
| --- | --- |
| Nearest neighbor (default) | Copies source RGBA values without blending; suitable for pixel art, tiles, and sprites |
| Area average | Coverage-weighted averaging, mainly for thumbnails and large reductions |
| Bilinear | Smooth interpolation between neighboring pixels |
| Bicubic | Balances smoothness and sharpness; may produce slight edge halos |
| Lanczos 3 | Preserves detail with a higher computation cost; may produce ringing at high-contrast edges |

Smooth algorithms use premultiplied alpha to keep hidden RGB values in transparent pixels from contaminating visible edges. Each layer is resized separately; names, order, visibility, locks, opacity, and blend modes are preserved. Preview, apply, copy, and PNG export share the same resampling path. Each applied asset change can be undone in one step.

Batch processing uses frozen settings and skips completed items when continuing the same batch. Stopping leaves completed assets intact and does not commit the unfinished asset. Backgrounds and center/bounds markers are preview-only. Padding detects transparency; it does not remove white or other opaque backgrounds. Padding and resize settings are saved with projects and drafts.

## Applying pixel optimization

Applying optimization adds a result layer to the current asset while preserving its name and canvas dimensions. Relevant original layers are hidden and retained for undo. When using the active layer as the source, its blend mode, opacity, visibility, and stacking position are preserved.

Batch apply freezes the initial parameters and asset list, updates existing documents without increasing the asset count, and records one undo step per document. Modified or closed targets are skipped. Capacity checks happen before original layers are hidden. You can stop the queue or leave the mode; creating new optimized assets and exporting PNG remain available.

## Workspace assets, guides, and local file synchronization

Each asset has independent pixels, layers, and history. Composition scenes, tile scenes, optimization settings, and guides belong to the workspace. Asset duplication preserves layer data and properties with independent pixels/history, creates a unique name, and does not inherit the original file handle.

Guides include named points and horizontal/vertical lines with precise coordinates, colors, visibility, locks, and snapping. Pixel-coordinate guides use the same positions across assets; proportional guides adapt to each canvas. Guides are saved in projects and can be imported/exported as JSON or saved as `.paint-guides.json` in an authorized directory. They never appear in image exports.

**Open Working Directory** replaces the workspace after a successful read, resetting the previous scenes, parameters, selection, clipboard, and search. Guides come from the new directory, or are cleared if no configuration exists. Cancelled or failed switches preserve the existing workspace. A confirmed empty directory creates a transparent 960×640 canvas. **Import Images** appends assets instead.

After browser directory write access is granted, automatic local synchronization is enabled by default. About **800 ms** after editing stops, committed asset changes are composited and written to the corresponding image file. New assets use unique filenames; sources outside the working directory are saved as new files inside it. Pending drawing/text/selection operations wait until committed.

The interface shows queued, writing, synced, paused, and failed states, with a retry action. Read-only imports, restored projects, and browser drafts do not grant disk write permission. Synchronization updates image files; editable layers, guides, and scenes still require drafts or a saved project. Browser support, a secure context, and explicit directory access are required; desktop Edge or Chrome can be used for these features.

## Region capture

Use **K** or the region-capture toolbar/menu entry to draw an integer-pixel rectangle. Move it, resize its eight handles, or enter X/Y/width/height. Arrow keys move 1 px, or 10 px with Shift. Escape/Delete resets only the capture rectangle.

Save or press Enter to create an independent PNG asset from the visible-layer composite in that region, retaining transparency. View zoom does not affect output dimensions. Preview overlays are excluded. Keep the source selected for repeated extraction or choose to open the new asset immediately. Saving to the workspace creates an in-browser asset; use image save/export or project save for disk output.

## File formats and projects

| Purpose | Formats |
| --- | --- |
| Image import | PNG, JPEG, WebP, BMP, GIF, SVG, AVIF; decoding depends on the browser |
| Drawing export | PNG, JPEG, WebP, BMP, static GIF |
| Composition export | PNG, JPEG, WebP, with range, scale, margin, and transparency options |
| Tile canvas export | Full PNG, or PNG tiles plus `layout.json` in ZIP |
| Pixel conversion export | PNG, SVG, and batch ZIP |
| Pixel optimization export | Transparent PNG with integer scaling |
| Workspace image export | ZIP of asset images |
| Editable workspace | `.paintspace` JSON with layer pixels, metadata, blend modes, guides, settings, source images, scenes, and processing parameters |
| Guides | Guide JSON or `.paint-guides.json` |

Image exports flatten visible layers. Save a `.paintspace` project as well to continue layered editing. Projects retain applied edits, excluding unconfirmed retouching previews. Undo history belongs to the current session; reopening a project establishes a new history starting point.

Older `.paintspace`, `.pinjing`, and `.pixelroom`/Pixelroom JSON projects can be imported. Settings absent from older files use defaults. Pixelroom transforms and color filters are baked into individual layer pixels while layer properties are retained. Browser drafts are isolated by site; export projects/images from the original site before importing here.

IndexedDB drafts help restore work in the same browser. Clearing site data, storage pressure, or switching browsers can affect draft availability. Save project files and final images explicitly. Restoring a project does not restore directory write permission; select the directory again.

## Keyboard shortcuts

| Context | Shortcuts |
| --- | --- |
| Drawing / Retouching | Ctrl/Cmd+S save image; Ctrl/Cmd+Z undo; Ctrl/Cmd+Y redo; Ctrl/Cmd+C/X/V copy/cut/paste |
| Other modes | Ctrl/Cmd+S save the complete workspace project |
| Drawing tools | B brush, P pencil, E eraser, F fill, I eyedropper, T text, M rectangle selection, L free selection, V layer move, H pan, K region capture |
| Drawing view | Space-drag pan; wheel zoom; Shift constrain; X swap foreground/background |
| Tile canvas | M measurement, V move, R rotate, Shift rotate in 15° steps, H pan, Alt suspend snapping |
| Slicing | Space/middle-button drag pan; wheel zoom; Escape cancel drag or generation |
| Transparent padding | Ctrl/Cmd+Z undo; Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z redo |
| Floating selection / polygon | Enter finish; Escape cancel |

Shortcuts depend on the current mode. See the in-app help and tooltips for the full set.

## Source layout and verification

| Path | Responsibility |
| --- | --- |
| `dist/index.html`, `dist/style.css`, `dist/workbench.css` | Application shell, workspace layout, and styling |
| `dist/app.js`, `dist/workbench.js` | Documents, interaction, shortcuts, mode switching, and state coordination |
| `dist/core.js`, `dist/drawing.js` | Raster layers, compositing, history, brushes, shapes, and pixel operations |
| `dist/converter.js`, `dist/conversion-core.js`, `dist/conversion-worker.js` | Pixel conversion, sampling, palette reduction, SVG output, and worker execution |
| `dist/inspections.js`, `dist/fine-raster.js` | Retouching, inspection, navigation, and sharpening |
| `dist/composer.js`, `dist/composition-geometry.js`, `dist/composition-slots.js`, `dist/composition-slot-editor.js` | Composition, transforms, alignment, docking constraints, and anchor editing |
| `dist/tile-canvas-*.js` | Fixed canvas parameters, movement/rotation controls, measurement, and tile export |
| `dist/slicer.js`, `dist/slice-core.js`, `dist/slice-raster.js`, `dist/workspace-documents.js` | Slice geometry, RGBA extraction, capacity checks, and atomic asset creation |
| `dist/optimizer.js`, `dist/pixel-core.js`, `dist/pixel-worker.js`, `dist/optimization-result.js` | Optimization controls, algorithms, workers, and safe result application |
| `dist/padding.js`, `dist/padding-core.js`, `dist/padding-raster.js`, `dist/image-resampling.js`, `dist/padding-resize-worker.js` | Padding geometry, per-layer resizing, sampling, and asynchronous processing |
| `dist/region-capture.js`, `dist/capture-core.js`, `dist/canvas-frame*.js`, `dist/layer-move.js` | Region capture, frame resizing, and whole-layer movement |
| `dist/io.js`, `dist/autosave.js`, `dist/local-file-sync.js` | Image/project I/O, ZIP, directory access, drafts, and synchronization |
| `dist/liquid-glass.js`, `dist/liquid-theme-init.js` | Appearance preferences, accessibility, and adaptive effects |
| `dist/start.bat`, `dist/start.sh` | Local HTTP launchers |
| `tests/`, `qa-inputs/`, `docs/` | Regression checks, QA fixtures, and screenshots |

Tests use Node.js. For example, run these from the repository root:

```sh
node tests/conversion-core.test.mjs
node tests/slice-core.test.mjs
node tests/tile-canvas-core.test.mjs
node tests/liquid-glass.test.mjs
```

Some raster and integration tests require a native Canvas runtime. Node.js and test dependencies are not required to run the application. Detailed historical verification records are retained in the [Chinese README](README.md#验证记录). Component tests that use DOM stubs do not replace browser checks for layout, touch, focus, pointer capture, or file delivery.

## Scope and limitations

- This is an independently implemented browser drawing tool. It is not an official Microsoft Paint product and does not claim exact parity with any Windows version.
- Microsoft Cocreator, Image Creator, and cloud generative editing are not connected. Color-based background removal uses a local connected-region algorithm and works best on relatively uniform backgrounds.
- GIF input uses a static frame; GIF output is static. There is no animation timeline or system wallpaper integration.
- Drawing canvases support up to 8192 px per side and roughly 32 million pixels in total. Other modes apply their own asset, layer, output, and cumulative pixel budgets. Large images, many layers, and high export scales increase memory use.
- Undo history is limited by step and memory budgets. Project and draft recovery preserve edited content without restoring the full previous session's undo timeline.
- Sending a composition to Drawing bakes scene transforms into output layer pixels. The complete workspace project retains the editable composition scene.
