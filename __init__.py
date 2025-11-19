# Enkel nod för Tomas videoparametrar
# Inga externa beroenden krävs

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
                "short_side": (
                    "INT",
                    {
                        "default": 480,
                        "min": 64,
                        "max": 8192,
                        "step": 8,
                        "label": "Shortest Side Length",
                    },
                ),
            },
        }

    # Outputs: Vi skickar fortfarande ut width/height separat så att andra noder kan använda dem
    RETURN_TYPES = ("FLOAT", "INT", "INT", "INT", "INT")
    RETURN_NAMES = ("fps", "duration", "width", "height", "nr_frames")
    FUNCTION = "calculate_params"
    CATEGORY = "HELTO/Video"

    def calculate_params(self, fps, duration, aspect_ratio, short_side):
        # Parsa bildförhållandet från strängen (t.ex. "16:9" -> 16 och 9)
        w_str, h_str = aspect_ratio.split(":")
        w_ratio = int(w_str)
        h_ratio = int(h_str)

        target_width = 0
        target_height = 0

        # Logik för att räkna ut dimensionerna baserat på kortaste sidan
        if w_ratio > h_ratio:  # Landskap (Bredare än hög)
            # Höjden blir den korta sidan
            target_height = short_side
            # Bredden skalas upp
            target_width = short_side * (w_ratio / h_ratio)

        elif h_ratio > w_ratio:  # Porträtt (Högre än bred)
            # Bredden blir den korta sidan
            target_width = short_side
            # Höjden skalas upp
            target_height = short_side * (h_ratio / w_ratio)

        else:  # Kvadrat (1:1)
            target_width = short_side
            target_height = short_side

        # Viktigt: Se till att dimensionerna är delbara med 8 (standard för SD/ComfyUI)
        # Vi använder round() för att avrunda till närmaste heltal först
        final_width = int(round(target_width / 8) * 8)
        final_height = int(round(target_height / 8) * 8)

        # Beräkna antalet frames: (fps * duration) + 1
        nr_frames = int((fps * duration) + 1)

        return (fps, duration, final_width, final_height, nr_frames)


# Mappning för ComfyUI
NODE_CLASS_MAPPINGS = {"HeltoVideoParams": HeltoVideoParams}

# Namn i menyn
NODE_DISPLAY_NAME_MAPPINGS = {"HeltoVideoParams": "Video Parameters"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
