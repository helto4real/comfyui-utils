import math

# Enkel nod för Tomas videoparametrar
print("Loading HELTO Video Parameters Node...")


class HeltoVideoParams:
    """
    En nod som beräknar upplösning baserat på bildförhållande och kortaste sida,
    samt beräknar totalt antal frames.
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
                "aspect_ratio": (["16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:1"],),
                "use_max_side": ("BOOLEAN", {"default": False}),
                "side_length": (
                    "INT",
                    {"default": 480, "min": 64, "max": 8192, "step": 8},
                ),
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

    RETURN_TYPES = ("FLOAT", "INT", "INT", "INT", "INT", "INT", "FLOAT", "FLOAT")
    RETURN_NAMES = (
        "fps",
        "duration",
        "width",
        "height",
        "nr_frames",
        "steps",
        "shift_value",
        "motion_amplitude",
    )
    FUNCTION = "calculate_params"
    CATEGORY = "HELTO/Video"

    def calculate_params(
        self,
        fps,
        duration,
        aspect_ratio,
        side_length,
        use_max_side,
        steps,
        shift_value,
        motion_amplitude,
    ):
        # Parsa bildförhållandet
        w_str, h_str = aspect_ratio.split(":")
        w_ratio = int(w_str)
        h_ratio = int(h_str)

        target_width = 0
        target_height = 0

        # Logik för att bestämma vilken sida som ska styra
        # Vi kollar först om bredden är större än höjden (landskap)
        is_landscape = w_ratio > h_ratio
        is_portrait = h_ratio > w_ratio

        if use_max_side:
            # Om vi vill att side_length ska vara den LÅNGA sidan
            if is_landscape:
                target_width = side_length
                target_height = side_length * (h_ratio / w_ratio)
            elif is_portrait:
                target_height = side_length
                target_width = side_length * (w_ratio / h_ratio)
            else:  # Kvadrat
                target_width = target_height = side_length
        else:
            # Om vi vill att side_length ska vara den KORTA sidan (som tidigare)
            if is_landscape:
                target_height = side_length
                target_width = side_length * (w_ratio / h_ratio)
            elif is_portrait:
                target_width = side_length
                target_height = side_length * (h_ratio / w_ratio)
            else:  # Kvadrat
                target_width = target_height = side_length

        # Avrunda till närmaste multipel av 8 (viktigt för videocodecs/AI-modeller)
        final_width = int(round(target_width / 8) * 8)
        final_height = int(round(target_height / 8) * 8)

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
                "aspect_ratio": (["1:1", "3:2", "4:3", "16:9", "21:9"],),
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
        # Beräkna kvoten (t.ex. 16 / 9 = 1.777...)
        ratio_value = float(parts[0]) / float(parts[1])

        if use_max_side:
            # Om side_length ska vara den LÅNGA sidan
            long_side = side_length
            short_side = int(side_length / ratio_value)
        else:
            # Om side_length ska vara den KORTA sidan
            short_side = side_length
            long_side = int(side_length * ratio_value)

        # Se till att båda sidorna är jämnt delbara med 8
        long_side = (long_side // 8) * 8
        short_side = (short_side // 8) * 8

        # Sätt bredd och höjd baserat på valt läge (liggande/stående)
        if orientation == "landscape":
            width = long_side
            height = short_side
        else:
            width = short_side
            height = long_side

        return (width, height)


# class AspectRatioCalculator:
#     def __init__(self):
#         pass
#
#     @classmethod
#     def INPUT_TYPES(s):
#         return {
#             "required": {
#                 "short_side": (
#                     "INT",
#                     {"default": 512, "min": 64, "max": 8192, "step": 8},
#                 ),
#                 "aspect_ratio": (["1:1", "3:2", "4:3", "16:9", "21:9"],),
#                 "orientation": (["landscape", "portrait"],),
#             },
#         }
#
#     RETURN_TYPES = ("INT", "INT")
#     RETURN_NAMES = ("width", "height")
#     FUNCTION = "calculate"
#     CATEGORY = "HELTO/Utils"
#
#     def calculate(self, short_side, aspect_ratio, orientation):
#         parts = aspect_ratio.split(":")
#         ratio_value = float(parts[0]) / float(parts[1])
#         long_side = int(short_side * ratio_value)
#         long_side = (long_side // 8) * 8
#
#         if orientation == "landscape":
#             width = long_side
#             height = short_side
#         else:
#             width = short_side
#             height = long_side
#
#         return (width, height)
#

# Registrering av noder
NODE_CLASS_MAPPINGS = {
    "HeltoVideoParams": HeltoVideoParams,
    "AspectRatioCalculator": AspectRatioCalculator,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "HeltoVideoParams": "Video Parameters",
    "AspectRatioCalculator": "Aspect Ratio Calculator",
}
