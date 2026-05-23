import math

# Enkel nod för Tomas videoparametrar
print("Loading HELTO Video Parameters Node...")


class HeltoVideoParams:
    """
    En nod som returnerar exakta, optimala upplösningar för Wan 2.2
    baserat på kvalitetsnivå och bildförhållande.
    """

    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "fps": (
                    "FLOAT",
                    {"default": 24.0, "min": 1.0, "max": 120.0, "step": 0.01},
                ),
                "duration": ("INT", {"default": 5, "min": 1, "max": 10000, "step": 1}),
                "aspect_ratio": (["16:9", "4:3", "3:2", "1:1"],),
                "orientation": (["landscape", "portrait"], {"default": "landscape"}),
                "quality_tier": (
                    [
                        "1 - fast samples",
                        "2 - fast and ok",
                        "3 - reasonable",
                        "4 - better details",
                        "5 - really good",
                        "6 - WAN 2.2 native",
                    ],
                    {"default": "6 - WAN 2.2 native"},
                ),
                "use_nfsw": ("BOOLEAN", {"default": False}),
                "motion_amplitude": (
                    "FLOAT",
                    {"default": 1.15, "min": 1.0, "max": 1.5, "step": 0.05},
                ),
                "steps": ("INT", {"default": 6, "min": 4, "max": 12, "step": 1}),
                "shift_value": (
                    "FLOAT",
                    {"default": 8.0, "min": 1.0, "max": 10.0, "step": 0.5},
                ),
            },
        }

    RETURN_TYPES = (
        "FLOAT",
        "INT",
        "INT",
        "INT",
        "INT",
        "INT",
        "FLOAT",
        "FLOAT",
        "BOOLEAN",
    )
    RETURN_NAMES = (
        "fps",
        "duration",
        "width",
        "height",
        "nr_frames",
        "steps",
        "shift_value",
        "motion_amplitude",
        "use_nfsw",
    )
    FUNCTION = "calculate_params"
    CATEGORY = "HELTO/Video"

    def calculate_params(
        self,
        fps,
        duration,
        aspect_ratio,
        orientation,
        quality_tier,
        steps,
        shift_value,
        motion_amplitude,
        use_nfsw,
    ):
        # Dictionary baserad på Wan 2.2 rekommenderade upplösningar.
        # Sparade som (kort_sida, lång_sida) för att matcha 1:1, 3:4, 2:3 och 9:16 i listan.
        wan_resolutions = {
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

        # Extrahera index (0-5) från vald kvalitetsnivå
        tier_index = int(quality_tier.split(" - ")[0]) - 1

        # Hämta basupplösningen för valt bildförhållande
        base_w, base_h = wan_resolutions[aspect_ratio][tier_index]

        # Anpassa efter orientering
        if aspect_ratio == "1:1":
            final_width, final_height = base_w, base_h
        elif orientation == "landscape":
            final_width = max(base_w, base_h)
            final_height = min(base_w, base_h)
        else:  # portrait
            final_width = min(base_w, base_h)
            final_height = max(base_w, base_h)

        # Beräkna totalt antal frames
        nr_frames = int((fps * duration) + 1)

        return (
            fps,
            duration,
            final_width,
            final_height,
            nr_frames,
            steps,
            shift_value,
            motion_amplitude,
            use_nfsw,
        )


class HeltoVideoParamsLTX:
    """
    En nod som returnerar exakta, optimala upplösningar för LTX 2.3
    baserat på kvalitetsnivå och bildförhållande.
    """

    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "fps": (
                    "FLOAT",
                    {"default": 24.0, "min": 1.0, "max": 120.0, "step": 0.01},
                ),
                "duration": ("INT", {"default": 5, "min": 1, "max": 10000, "step": 1}),
                "aspect_ratio": (["16:9", "4:3", "3:2", "1:1"],),
                "orientation": (["landscape", "portrait"], {"default": "landscape"}),
                "quality_tier": (
                    [
                        "1 - fast samples",
                        "2 - fast and ok",
                        "3 - reasonable",
                        "4 - better details",
                        "5 - really good",
                        "6 - LTX 2.3 native",
                    ],
                    {"default": "6 - LTX 2.3 native"},
                ),
                "use_nfsw": ("BOOLEAN", {"default": False}),
                "motion_amplitude": (
                    "FLOAT",
                    {"default": 1.15, "min": 1.0, "max": 1.5, "step": 0.05},
                ),
                "steps": ("INT", {"default": 8, "min": 1, "max": 50, "step": 1}),
                "shift_value": (
                    "FLOAT",
                    {"default": 8.0, "min": 1.0, "max": 10.0, "step": 0.5},
                ),
            },
        }

    RETURN_TYPES = (
        "FLOAT",
        "INT",
        "INT",
        "INT",
        "INT",
        "INT",
        "FLOAT",
        "FLOAT",
        "BOOLEAN",
    )
    RETURN_NAMES = (
        "fps",
        "duration",
        "width",
        "height",
        "nr_frames",
        "steps",
        "shift_value",
        "motion_amplitude",
        "use_nfsw",
    )
    FUNCTION = "calculate_params"
    CATEGORY = "HELTO/Video"

    def calculate_params(
        self,
        fps,
        duration,
        aspect_ratio,
        orientation,
        quality_tier,
        steps,
        shift_value,
        motion_amplitude,
        use_nfsw,
    ):
        # Dictionary baserad på LTX 2.3 rekommenderade upplösningar.
        # För LTX måste all bredd och höjd vara jämnt delbara med 32.
        # Sparade som (kort_sida, lång_sida).
        ltx_resolutions = {
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
                (704, 1216),  # LTX standard för 16:9
                (1088, 1920),  # LTX 2.3 Native 1080p
            ],
        }

        # Extrahera index (0-5) från vald kvalitetsnivå
        tier_index = int(quality_tier.split(" - ")[0]) - 1

        # Hämta basupplösningen för valt bildförhållande
        short_side, long_side = ltx_resolutions[aspect_ratio][tier_index]

        # Anpassa efter orientering
        if aspect_ratio == "1:1":
            final_width, final_height = long_side, short_side
        elif orientation == "landscape":
            final_width = max(short_side, long_side)
            final_height = min(short_side, long_side)
        else:  # portrait
            final_width = min(short_side, long_side)
            final_height = max(short_side, long_side)

        # Beräkna totalt antal frames
        # LTX-Video kräver strikt att antalet frames är (N * 8) + 1 (t.ex. 9, 17, 97, 257)
        target_frames = int(fps * duration)
        nr_frames = ((target_frames - 1) // 8) * 8 + 1

        # Säkerställ att vi minst har 9 frames
        if nr_frames < 9:
            nr_frames = 9

        return (
            fps,
            duration,
            final_width,
            final_height,
            nr_frames,
            steps,
            shift_value,
            motion_amplitude,
            use_nfsw,
        )


class AspectRatioCalculator:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "side_length": (
                    "INT",
                    {"default": 512, "min": 64, "max": 8192, "step": 8},
                ),
                "aspect_ratio": (["1:1", "3:2", "4:3", "16:9"],),
                "orientation": (["landscape", "portrait"],),
                "use_max_side": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("width", "height")
    FUNCTION = "calculate"
    CATEGORY = "HELTO/Utils"

    def calculate(self, side_length, aspect_ratio, orientation, use_max_side):
        parts = aspect_ratio.split(":")
        ratio_value = float(parts[0]) / float(parts[1])

        if use_max_side:
            long_side = side_length
            short_side = int(side_length / ratio_value)
        else:
            short_side = side_length
            long_side = int(side_length * ratio_value)

        long_side = (long_side // 8) * 8
        short_side = (short_side // 8) * 8

        if orientation == "landscape":
            width = long_side
            height = short_side
        else:
            width = short_side
            height = long_side

        return (width, height)


class ModelAutoRouter:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {},
            "optional": {
                "model_a": ("MODEL",),
                "model_b": ("MODEL",),
            },
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "route_model"
    CATEGORY = "custom_logic"

    def route_model(self, model_a=None, model_b=None):
        if model_a is not None:
            return (model_a,)

        if model_b is not None:
            return (model_b,)

        raise ValueError(
            "Ingen modell hittades! Koppla in eller av-muta minst en modell."
        )


# Registrering av noder
NODE_CLASS_MAPPINGS = {
    "HeltoVideoParams": HeltoVideoParams,
    "HeltoVideoParamsLTX": HeltoVideoParamsLTX,
    "AspectRatioCalculator": AspectRatioCalculator,
    "ModelAutoRouter": ModelAutoRouter,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "HeltoVideoParams": "Video Parameters",
    "HeltoVideoParamsLTX": "Video Parameters LTX",
    "AspectRatioCalculator": "Aspect Ratio Calculator",
    "ModelAutoRouter": "Model Auto Router (Mute-safe)",
}
