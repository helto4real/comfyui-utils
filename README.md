# Helto ComfyUI Utils

Helto ComfyUI Utils is a small ComfyUI custom node pack for everyday workflow glue: video parameter helpers, image and video comparison previews, model routing, and advanced image/video saving.

![Helto ComfyUI Utils overview](docs/assets/helto-utils-overview.png)

## Installation

Install the pack into ComfyUI's `custom_nodes` directory, then restart ComfyUI.

```bash
cd /path/to/ComfyUI/custom_nodes
git clone git@github.com:helto4real/comfyui-utils.git
```

The pack registers through ComfyUI's V3 `comfy_entrypoint()` extension API and exposes its frontend assets from `./web`. If ComfyUI is already running, restart it after installing or updating the node pack so the Python nodes and JavaScript widgets are reloaded.

`Save Video Advanced` needs `ffmpeg` for video container outputs. It first tries `imageio-ffmpeg`, then falls back to `ffmpeg` on `PATH`.

## Node Catalog

| Node | ID | Category | What it is for |
| --- | --- | --- | --- |
| Video Parameters | `HeltoVideoParams` | `HELTO/Video` | WAN 2.2 width, height, frame count, and sampler parameter helper. |
| Video Parameters LTX | `HeltoVideoParamsLTX` | `HELTO/Video` | LTX 2.3 width, height, frame-safe frame count, and sampler parameter helper. |
| Aspect Ratio Calculator | `AspectRatioCalculator` | `HELTO/Utils` | Converts a side length plus aspect ratio into width and height. |
| Model Auto Router (Mute-safe) | `ModelAutoRouter` | `HELTO/Utils` | Routes `model_a` when connected, otherwise falls back to `model_b`. |
| Image Comparer | `HeltoImageComparer` | `HELTO/Image` | Output node that previews an original image against a new image. |
| Video Comparer | `HeltoVideoComparer` | `HELTO/Video` | Output node that previews two videos or frame batches side by side. |
| Save Image Advanced | `HeltoSaveImageAdvanced` | `HELTO/Image` | Saves PNG images to an absolute folder with alternate/date/subfolder routing. |
| Save Video Advanced | `HeltoSaveVideoAdvanced` | `HELTO/Video` | Saves frame batches or latents as GIF, WebP, or video with folder routing and format controls. |

## Parameter Helpers

### Video Parameters

`Video Parameters` returns WAN 2.2-oriented dimensions and sampler values that can be wired into video workflows.

Inputs:

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `fps` | Float | `24.0` | Frames per second. |
| `duration` | Int | `5` | Duration in seconds. |
| `aspect_ratio` | Combo | first option | One of `16:9`, `4:3`, `3:2`, `1:1`. |
| `orientation` | Combo | `landscape` | `landscape` or `portrait`; ignored for square output. |
| `quality_tier` | Combo | `6 - WAN 2.2 native` | Selects one of the built-in WAN resolution tiers. |
| `use_nfsw` | Boolean | `False` | Passed through as a boolean output with the same name. |
| `motion_amplitude` | Float | `1.15` | Passed through for downstream sampler controls. |
| `steps` | Int | `6` | Passed through for downstream sampler controls. |
| `shift_value` | Float | `8.0` | Passed through for downstream sampler controls. |

Outputs: `fps`, `duration`, `width`, `height`, `nr_frames`, `steps`, `shift_value`, `motion_amplitude`, `use_nfsw`.

Frame count is calculated as `int((fps * duration) + 1)`. Dimensions come from the selected WAN tier and are flipped for portrait orientation.

### Video Parameters LTX

`Video Parameters LTX` is the LTX 2.3 version of the same helper.

It uses the same input and output shape as `Video Parameters`, but its default quality tier is `6 - LTX 2.3 native`, its default `steps` value is `8`, and its frame count is adjusted to LTX-safe counts. The node calculates a target from `fps * duration`, rounds down to an `8n + 1` frame count, and never returns fewer than `9` frames.

### Aspect Ratio Calculator

`Aspect Ratio Calculator` turns a side length into width and height values.

Inputs:

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `side_length` | Int | `512` | Side length from `64` to `8192`, stepped by `8`. |
| `aspect_ratio` | Combo | first option | One of `16:9`, `4:3`, `3:2`, `1:1`. |
| `orientation` | Combo | first option | `landscape` or `portrait`. |
| `use_max_side` | Boolean | `False` | When false, `side_length` is the short side. When true, it is the long side. |

Outputs: `width`, `height`.

Both dimensions are rounded down to multiples of 8 before output.

## Routing

### Model Auto Router (Mute-safe)

`Model Auto Router (Mute-safe)` is useful when a workflow may have alternate model branches.

Inputs:

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `model_a` | Model | No | Preferred model input. |
| `model_b` | Model | No | Fallback model input. |

Output: one `MODEL`.

If `model_a` is connected, it is returned. If `model_a` is missing and `model_b` is connected, `model_b` is returned. If neither input is available, the node raises an error telling you to connect or unmute at least one model.

## Compare Previews

### Image Comparer

`Image Comparer` is an output node for visual A/B checks inside the graph.

Inputs:

| Input | Type | Notes |
| --- | --- | --- |
| `original` | Image | Baseline image batch. |
| `new` | Image | Candidate image batch. |

Outputs: none. The node saves temporary preview images and returns UI data for the frontend widget.

The frontend extension adds a `hide mode` toggle. With hide mode enabled, the node shows a placeholder until the pointer is over the preview area. When both images are available, the preview uses a vertical split that follows the pointer so you can compare the original and new image in place.

### Video Comparer

`Video Comparer` is an output node for synchronized side-by-side video review.

Inputs:

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `video_1` | Video or Image | required | A ComfyUI video object or an image frame batch. |
| `video_2` | Video or Image | required | A ComfyUI video object or an image frame batch. |
| `audio_1` | Audio | optional | Audio source for the first preview. |
| `audio_2` | Audio | optional | Audio source for the second preview. |
| `frame_rate` | Float | `24.0` | Used when image batches are encoded into preview videos. |

Outputs: none. The node writes temporary MP4 previews under ComfyUI's temp directory and returns UI data for the frontend widget.

The frontend widget provides synchronized playback, a timeline, time display, hide mode, and an `audio source` selector with `video 1`, `video 2`, and `muted`. Image batches are converted to H.264 MP4 previews; odd image dimensions are padded for encoder compatibility.

## Advanced Saving

### Save Image Advanced

`Save Image Advanced` saves PNG images to a chosen absolute folder while passing the image batch through.

Inputs:

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `images` | Image | optional | If missing, the node reuses its cached preview UI. |
| `folder` | String | ComfyUI output directory | Primary absolute output folder. |
| `alternative_folder` | String | empty | Alternate absolute output folder. |
| `use_alternative_folder` | Boolean | `False` | Selects `alternative_folder` instead of `folder`. |
| `use_date_folder` | Boolean | `False` | Appends a `YYYY-MM-DD` folder. |
| `subfolder` | String | empty | Relative subfolder appended after the optional date folder. |
| `filename_prefix` | String | `img` | Prefix for numbered files. |

Output: `images`.

Files are saved as `filename_prefix_00001.png`, `filename_prefix_00002.png`, and so on. The counter continues from matching files already in the destination folder. The node requires an absolute base folder, rejects absolute subfolders, rejects subfolder path traversal, and stores workflow metadata in PNG output when ComfyUI metadata is enabled.

The frontend extension adds hide-mode behavior for image previews.

### Save Video Advanced

`Save Video Advanced` saves frame batches or latents as animated images or videos while passing through decoded images and audio.

Inputs:

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `images` | Image or Latent | optional | Connect a VAE when passing latents. |
| `audio` | Audio | optional | Muxed into supported video outputs. |
| `vae` | VAE | optional | Required only when `images` receives latents. |
| `frame_rate` | Float | `24.0` | Output frame rate. |
| `loop_count` | Int | `0` | Loop count for animated image and ffmpeg loop handling. |
| `folder` | String | ComfyUI output directory | Primary absolute output folder. |
| `alternative_folder` | String | empty | Alternate absolute output folder. |
| `use_alternative_folder` | Boolean | `False` | Selects `alternative_folder` instead of `folder`. |
| `use_date_folder` | Boolean | `False` | Appends a `YYYY-MM-DD` folder. |
| `subfolder` | String | empty | Relative subfolder appended after the optional date folder. |
| `filename_prefix` | String | `video` | Prefix for numbered files. |
| `format` | Combo | `video/h264-mp4` when available | Includes `image/gif`, `image/webp`, and discovered/fallback video presets. |
| `pingpong` | Boolean | `False` | Appends reversed middle frames for a ping-pong loop. |
| `save_output` | Boolean | `True` | When false, writes to ComfyUI temp instead of the selected output folder. |

Outputs: `images`, `audio`, and `filenames` as `VHS_FILENAMES`.

The `filenames` output is a tuple of `(save_output, output_files)`, matching VideoHelperSuite-style filename consumers. When audio is muxed, the node can return both the silent video path and an `-audio` muxed path.

Formats come from VideoHelperSuite-compatible JSON presets when they are available, with built-in fallbacks for `video/h264-mp4`, `video/webm`, and `video/ffmpeg-gif`. The frontend extension shows extra format-specific widgets after the `format` selector.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| `Save Image Advanced requires an absolute base folder path.` | Use an absolute path in `folder` or `alternative_folder`, such as `/home/me/ComfyUI/output`. |
| `subfolder must be relative` or `subfolder cannot contain path traversal` | Keep `subfolder` relative and do not use `..`. |
| `ffmpeg is required for Save Video Advanced video outputs.` | Install `imageio-ffmpeg` in the ComfyUI environment or make `ffmpeg` available on `PATH`. |
| Latent input fails in `Save Video Advanced` | Connect a VAE when the `images` input receives latents. |
| `Ingen modell hittades!` from `Model Auto Router` | Connect or unmute at least one of `model_a` or `model_b`. |
| Expected video format is missing | Install or check VideoHelperSuite-compatible `video_formats` JSON presets. Built-in fallback formats are still available. |
| Comparer preview is hidden | Toggle `hide mode` off, or hover the node preview area to reveal it. |

## Implementation Notes

This README is based on the current node schemas and behavior in this repository:

- Pack registration and web directory: `__init__.py`
- Node implementations: `nodes/**/__init__.py`
- Shared video dimensions and frame calculations: `shared/video_params.py`
- Frontend preview and save widgets: `web/*.js`

ComfyUI V3 extension loading, schema, and UI output behavior were checked against the local ComfyUI source in `comfy_api/latest/_io.py`, `comfy_api/latest/_ui.py`, and `nodes.py`.
