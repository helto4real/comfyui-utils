from __future__ import annotations

ASPECT_RATIOS = ["16:9", "4:3", "3:2", "1:1"]
ORIENTATIONS = ["landscape", "portrait"]

WAN_QUALITY_TIERS = [
    "1 - fast samples",
    "2 - fast and ok",
    "3 - reasonable",
    "4 - better details",
    "5 - really good",
    "6 - WAN 2.2 native",
]

LTX_QUALITY_TIERS = [
    "1 - fast samples",
    "2 - fast and ok",
    "3 - reasonable",
    "4 - better details",
    "5 - really good",
    "6 - LTX 2.3 native",
]

WAN_RESOLUTIONS = {
    "1:1": [
        (480, 480),
        (640, 640),
        (768, 768),
        (800, 800),
        (880, 880),
        (960, 960),
    ],
    "4:3": [
        (416, 544),
        (560, 720),
        (672, 864),
        (720, 912),
        (784, 1008),
        (848, 1088),
    ],
    "3:2": [
        (384, 576),
        (528, 768),
        (624, 912),
        (656, 960),
        (736, 1072),
        (784, 1136),
    ],
    "16:9": [
        (368, 624),
        (480, 848),
        (576, 1008),
        (608, 1072),
        (672, 1184),
        (720, 1264),
    ],
}

LTX_RESOLUTIONS = {
    "1:1": [
        (512, 512),
        (640, 640),
        (768, 768),
        (896, 896),
        (1024, 1024),
        (1088, 1088),
    ],
    "4:3": [
        (384, 512),
        (480, 640),
        (576, 768),
        (672, 896),
        (768, 1024),
        (1056, 1408),
    ],
    "3:2": [
        (384, 576),
        (512, 768),
        (576, 864),
        (704, 1056),
        (768, 1152),
        (1088, 1632),
    ],
    "16:9": [
        (320, 576),
        (448, 768),
        (512, 896),
        (576, 1024),
        (704, 1216),
        (1088, 1920),
    ],
}


def parse_quality_tier(quality_tier: str) -> int:
    return int(quality_tier.split(" - ")[0]) - 1


def calculate_video_dimensions(
    resolutions: dict[str, list[tuple[int, int]]],
    aspect_ratio: str,
    orientation: str,
    quality_tier: str,
) -> tuple[int, int]:
    short_side, long_side = resolutions[aspect_ratio][parse_quality_tier(quality_tier)]

    if aspect_ratio == "1:1":
        return short_side, long_side

    if orientation == "landscape":
        return max(short_side, long_side), min(short_side, long_side)

    return min(short_side, long_side), max(short_side, long_side)


def calculate_ltx_frames(fps: float, duration: int) -> int:
    target_frames = int(fps * duration)
    frame_count = ((target_frames - 1) // 8) * 8 + 1
    return max(frame_count, 9)


def calculate_aspect_dimensions(
    side_length: int,
    aspect_ratio: str,
    orientation: str,
    use_max_side: bool,
) -> tuple[int, int]:
    width_ratio, height_ratio = aspect_ratio.split(":")
    ratio_value = float(width_ratio) / float(height_ratio)

    if use_max_side:
        long_side = side_length
        short_side = int(side_length / ratio_value)
    else:
        short_side = side_length
        long_side = int(side_length * ratio_value)

    long_side = (long_side // 8) * 8
    short_side = (short_side // 8) * 8

    if orientation == "landscape":
        return long_side, short_side

    return short_side, long_side
