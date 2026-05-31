# Helto ComfyUI Utils

Helto ComfyUI Utils is a small ComfyUI custom node pack for everyday workflow glue: video parameter helpers, image and video comparison previews, model routing, multi-image selection, and advanced image/video saving.

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
| Load Video | `HeltoLoadVideo` | `HELTO/Video` | Loads videos from a searchable picker as frames, audio, and metadata. |
| Helto Multi-Image Selector | `HeltoImageSelector` | `image` | Selects multiple local images from a searchable browser and outputs both a list and batch. |
| Save Image Advanced | `HeltoSaveImageAdvanced` | `HELTO/Image` | Saves PNG images to an absolute folder with alternate/date/subfolder routing. |
| Save Video Advanced | `HeltoSaveVideoAdvanced` | `HELTO/Video` | Saves frame batches or latents as GIF, WebP, or video with folder routing and format controls. |

## Parameter Helpers

### Video Parameters

![Video Parameters infographic](docs/assets/node-infographics/video-parameters.png)

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

![Video Parameters LTX infographic](docs/assets/node-infographics/video-parameters-ltx.png)

`Video Parameters LTX` is the LTX 2.3 version of the same helper.

It uses the same input and output shape as `Video Parameters`, but its default quality tier is `6 - LTX 2.3 native`, its default `steps` value is `8`, and its frame count is adjusted to LTX-safe counts. The node calculates a target from `fps * duration`, rounds down to an `8n + 1` frame count, and never returns fewer than `9` frames.

### Aspect Ratio Calculator

![Aspect Ratio Calculator infographic](docs/assets/node-infographics/aspect-ratio-calculator.png)

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

![Model Auto Router infographic](docs/assets/node-infographics/model-auto-router.png)

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

![Image Comparer infographic](docs/assets/node-infographics/image-comparer.png)

`Image Comparer` is an output node for visual A/B checks inside the graph.

Inputs:

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `original` | Image | required | Baseline image batch. |
| `new` | Image | required | Candidate image batch. |
| `privacy_mode` | Boolean | `True` | When true, preview images are written through the encrypted private-media path. |

Outputs: none. The node saves preview images and returns UI data for the frontend widget.

The frontend extension adds a `hide mode` toggle. With hide mode enabled, the node shows a placeholder until the pointer is over the preview area. When both images are available, the preview uses a vertical split that follows the pointer so you can compare the original and new image in place.

### Video Comparer

![Video Comparer infographic](docs/assets/node-infographics/video-comparer.png)

`Video Comparer` is an output node for synchronized side-by-side video review.

Inputs:

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `video_1` | Video or Image | required | A ComfyUI video object or an image frame batch. |
| `video_2` | Video or Image | required | A ComfyUI video object or an image frame batch. |
| `audio_1` | Audio | optional | Audio source for the first preview. |
| `audio_2` | Audio | optional | Audio source for the second preview. |
| `frame_rate` | Float | `24.0` | Used when image batches are encoded into preview videos. |
| `privacy_mode` | Boolean | `True` | When true, preview MP4 data is written through the encrypted private-media path. |

Outputs: none. The node writes MP4 previews and returns UI data for the frontend widget.

The frontend widget provides synchronized playback, a timeline, time display, hide mode, and an `audio source` selector with `video 1`, `video 2`, and `muted`. Image batches are converted to H.264 MP4 previews; odd image dimensions are padded for encoder compatibility.

## Loading

### Load Video

![Load Video infographic](docs/assets/node-infographics/load-video.png)

`Load Video` loads a selected video into a ComfyUI image-frame batch and passes through audio plus source metadata.

Inputs are widgets only; the node has no incoming sockets. The video picker opens from the `choose video` button and can browse the default ComfyUI input folder plus configured folder aliases. The picker includes recursive browsing, search by relative filename/path, sort controls, refresh, column sizing, and muted hover previews.

Inputs:

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `video` | String | empty | Relative path selected from the video picker. |
| `video_folder_alias` | String | `input` | Hidden alias for the selected configured folder. |
| `start_time` | Float | `0.0` | Start offset in seconds. |
| `duration` | Float | `0.0` | Seconds to load; `0` loads to the end. |
| `force_rate` | Float | `0.0` | Output frame rate override; `0` keeps the source-derived rate. |
| `frame_load_cap` | Int | `0` | Maximum output frames; `0` means uncapped. |
| `skip_first_frames` | Int | `0` | Frames to skip after the start offset. |
| `select_every_nth` | Int | `1` | Keeps every nth frame. |
| `resize_mode` | Combo | `original` | `original`, `resize`, `pad`, or `crop`. |
| `custom_width` / `custom_height` | Int | `0` | Target size for resize/pad/crop; `0` uses the source dimension. |
| `privacy_mode` | Boolean | `True` | When true, the selected video preview is served through the private-media path. |

Outputs: `images`, `audio`, `fps`, `width`, `height`, `duration`.

Supported picker extensions are `mp4`, `mov`, `mkv`, `webm`, `avi`, and `m4v`. The node is marked as having intermediate output so its selected-video UI can persist when it sits on the path to another output node. The frontend adds a `hide mode` toggle for the node preview; when enabled, the selected video preview is hidden until hovered.

### Helto Multi-Image Selector

![Helto Multi-Image Selector infographic](docs/assets/node-infographics/multi-image-selector.png)

`Helto Multi-Image Selector` is a searchable image browser for selecting multiple local images directly in a ComfyUI node.

The frontend widget can scan one or more folders, enable recursive browsing, filter by root folder or subfolder, sort by date or name, search by filename/path, preview selected images, clear the selection, and delete selected images from disk when they are inside the configured scan scope. The selected-image list is stored in hidden widgets so the workflow can run without visible input sockets.

Inputs:

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `selected_images` | String | `[]` | Hidden serialized selection. In privacy mode this is encrypted before prompt serialization. |
| `resize_mode` | String | `zoom to fit` | Hidden output sizing mode: `zoom to fit`, `pad`, or `No resize`. |

Outputs: `images` as an image list, and `image_batch` as a batched image tensor.

When no valid image is selected, the node returns a 512x512 black placeholder. `zoom to fit` resizes selected images to the first image's dimensions, `pad` pads images to the largest selected dimensions, and `No resize` preserves each loaded image before the batch output normalizes mixed sizes. Privacy mode also encrypts thumbnail cache entries and serialized selections.

## Advanced Saving

### Save Image Advanced

![Save Image Advanced infographic](docs/assets/node-infographics/save-image-advanced.png)

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
| `privacy_mode` | Boolean | `True` | When true, preview images are written through the encrypted private-media path. |

Output: `images`.

Files are saved as `filename_prefix_00001.png`, `filename_prefix_00002.png`, and so on. The counter continues from matching files already in the destination folder. The node requires an absolute base folder, rejects absolute subfolders, rejects subfolder path traversal, and stores workflow metadata in PNG output when ComfyUI metadata is enabled.

The frontend extension adds hide-mode behavior for image previews.

### Save Video Advanced

![Save Video Advanced infographic](docs/assets/node-infographics/save-video-advanced.png)

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
| `privacy_mode` | Boolean | `True` | When true, previews are served through the encrypted private-media path, including preview-only runs with `save_output=False`. |

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
| `Save Video Advanced private preview is not available downstream` | With `save_output=False` and `privacy_mode=True`, the encrypted UI preview is available, but `filenames` is intentionally empty because no readable video file is saved. |
| `Ingen modell hittades!` from `Model Auto Router` | Connect or unmute at least one of `model_a` or `model_b`. |
| Expected video format is missing | Install or check VideoHelperSuite-compatible `video_formats` JSON presets. Built-in fallback formats are still available. |
| Comparer or selector preview is hidden | Toggle `hide mode` off, or hover the node preview area to reveal it. |
| Multi-image selector returns a black image | Select at least one existing image, or refresh/rescan if a previously selected file moved. |

## Implementation Notes

This README is based on the current node schemas and behavior in this repository:

- Pack registration and web directory: `__init__.py`
- Node implementations: `nodes/**/__init__.py` and `helto_selector_backend/node.py`
- Selector backend routes and services: `helto_selector_backend/routes.py`, `helto_selector_backend/services.py`, and `helto_selector_backend/image_processing.py`
- Shared video dimensions and frame calculations: `shared/video_params.py`
- Frontend selector, preview, load, and save widgets: `web/*.js`

ComfyUI V3 extension loading, schema, node output, list-output, and UI preview behavior were checked against the local ComfyUI source in `/home/thhel/git/ComfyUI/comfy_api/latest/_io.py`, `/home/thhel/git/ComfyUI/comfy_api/latest/_ui.py`, and `/home/thhel/git/ComfyUI/nodes.py`.
