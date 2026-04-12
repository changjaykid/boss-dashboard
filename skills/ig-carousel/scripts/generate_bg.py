#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "google-genai>=1.0.0",
#     "pillow>=10.0.0",
# ]
# ///
"""
Generate AI background images for IG carousel slides using Nano Banana Pro.

Usage:
    uv run generate_bg.py --data ig-carousel/drafts/{id}.json --output ig-carousel/output/{id}/backgrounds/

Reads the carousel JSON, generates a unique background for each slide
based on the slide content/topic. Output: bg_slide1.png, bg_slide2.png, ...
"""

import argparse
import json
import os
import random
import sys
import time
from pathlib import Path

# Slide-type to visual mood mapping — v5: warm, atmospheric, breathable
MOOD_MAP = {
    "cover": "atmospheric, inviting, soft depth of field, warm ambient",
    "content": "professional, calm, warm tones, soft lighting",
    "problem": "contemplative, warm shadows, depth, atmospheric haze",
    "steps": "clean, organized, warm professional, structured space",
    "solution": "warm, optimistic, clarity, soft natural light",
    "summary": "balanced, warm conclusion, gentle atmosphere",
    "cta": "inviting, warm energy, approachable, soft focus",
    "comparison": "balanced, warm analytical, soft contrast",
    "quote": "elegant, atmospheric, contemplative, warm minimal",
    "highlight": "elegant, atmospheric, contemplative, warm minimal",
    "keypoint": "focused, warm spotlight, clean, soft impact",
    "body": "professional, warm, informative, breathable",
    "detail": "warm, textured, informative, soft ambient",
}

# Topic pillar to visual theme mapping — v5: warm muted tones, atmospheric, breathable
# NOT dark/moody/black. Medium-dark exposure with visible details.
PILLAR_VISUALS = {
    "market": "modern city street with warm evening light, soft glass reflections, urban atmosphere with muted warm tones",
    "practical": "cozy coffee shop interior with warm ambient lighting, wooden textures, soft bokeh, cream and brown tones",
    "case_study": "modern office corridor with floor-to-ceiling windows, warm natural light, architectural lines, soft shadows",
    "opinion": "urban rooftop at golden hour, warm sky, city silhouette in background, atmospheric haze",
    "behind_scenes": "creative studio with warm natural light through large windows, plants, warm wood tones, lived-in feel",
    "dry_goods": "minimalist library with warm ambient lighting, wooden shelves, soft depth of field, warm brown tones",
    "tool_recommendation": "clean modern workspace with warm light, coffee on desk, city view through window, soft focus",
    "client_communication": "outdoor café terrace with warm afternoon light, blurred street scene, soft warm tones",
    "brand_strategy": "modern building lobby with warm marble and glass, architectural depth, soft ambient light",
    "startup_truth": "urban street at dusk with warm streetlights, gentle rain reflections, atmospheric but NOT dark",
    "data_insight": "city skyline at blue hour with warm window lights, wide view, gentle atmospheric haze",
    "industry_gossip": "bustling Asian market street with warm lantern light, soft crowd blur, warm festive atmosphere",
}

# Additional scene variety — v5: all warm, atmospheric, breathable
SCENE_VARIETY = [
    "modern shopping mall corridor with warm lighting, glass and marble, architectural depth, soft reflections",
    "warm staircase in modern building, natural light from above, geometric lines, cream and brown tones",
    "urban person walking (back view) on warm-lit street, shallow depth of field, atmospheric city background",
    "modern glass building exterior with warm sunset reflection, architectural photography, soft warm tones",
    "European cobblestone alley with warm string lights, soft evening atmosphere, warm stone textures",
    "modern hotel lobby with warm ambient lighting, plush seating, soft depth of field",
    "window frame with warm light streaming in, dust particles visible, soft atmospheric interior",
    "city street with warm bokeh lights, shallow depth of field, urban evening atmosphere",
    "modern concrete and wood interior, warm indirect lighting, minimalist architectural space",
    "park bench scene with warm golden hour light, soft tree bokeh, gentle atmospheric haze",
    "industrial-chic café interior with exposed brick, warm pendant lights, coffee atmosphere",
    "modern art gallery corridor with warm spotlights, clean walls, architectural perspective",
]


def build_scene_pool(pillar, total_slides):
    """Build a pool of unique scenes for all slides, no repeats."""
    pool = []
    # Always include the pillar-specific scene for cover
    pillar_scene = PILLAR_VISUALS.get(pillar, "modern city street photography")
    pool.append(pillar_scene)
    
    # Shuffle variety scenes and pick enough for remaining slides
    variety = list(SCENE_VARIETY)
    random.shuffle(variety)
    
    # Add variety scenes, avoiding duplicates
    for scene in variety:
        if len(pool) >= total_slides:
            break
        if scene != pillar_scene:
            pool.append(scene)
    
    # If still not enough, add remaining pillar visuals
    if len(pool) < total_slides:
        for key, scene in PILLAR_VISUALS.items():
            if len(pool) >= total_slides:
                break
            if scene not in pool:
                pool.append(scene)
    
    return pool


def generate_bg_prompt(slide, scene, slide_num):
    """Generate a background image prompt for a specific slide."""
    stype = slide.get("type", "body")
    mood = MOOD_MAP.get(stype, "professional, clean")

    prompt = (
        f"A stunning editorial photograph: {scene}. "
        f"Shot on Hasselblad X2D 100C with 45mm f/3.5 lens, medium format sensor. "
        f"Mood: {mood}. "
        f"Warm muted color palette with soft ambient lighting, atmospheric haze, "
        f"shallow depth of field, rich tonal range. "
        f"Color grading: warm tones like Kodak Portra 400, NOT cold, NOT blue, NOT neon. "
        f"Medium-dark exposure — visible environment details, breathable atmosphere, NOT too dark, NOT too bright. "
        f"Depth and dimension with foreground/background separation. "
        f"This is a HIGH-END REAL PHOTO, not illustration or 3D render. "
        f"NOT pure black background, NOT moody dark, NOT cartoon, NOT sci-fi, NOT tech-blue glow. "
        f"No text, no words, no letters, no numbers, no watermarks, no people's faces. "
        f"Portrait orientation (3:4 aspect ratio). "
        f"Ultra high quality, magazine editorial level, professional photography."
    )

    return prompt


def main():
    parser = argparse.ArgumentParser(description="Generate AI backgrounds for IG carousel")
    parser.add_argument("--data", required=True, help="Path to carousel JSON data file")
    parser.add_argument("--output", required=True, help="Output directory for background images")
    parser.add_argument("--resolution", default="1K", choices=["1K", "2K", "4K"],
                        help="Image resolution (default: 1K for speed)")
    parser.add_argument("--api-key", help="Gemini API key (overrides env)")
    args = parser.parse_args()

    # API key
    api_key = args.api_key or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("Error: No GEMINI_API_KEY set.", file=sys.stderr)
        sys.exit(1)

    # Load carousel data
    with open(args.data, "r", encoding="utf-8") as f:
        data = json.load(f)

    slides = data["slides"]
    pillar = data.get("pillar", "market")
    total = len(slides)
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    # Import heavy deps
    from google import genai
    from google.genai import types
    from PIL import Image as PILImage
    from io import BytesIO

    client = genai.Client(api_key=api_key)

    # Build unique scene pool — each slide gets a different scene
    scene_pool = build_scene_pool(pillar, total)
    print(f"  🎬 Scene pool ({len(scene_pool)} unique scenes):")
    for si, sc in enumerate(scene_pool):
        print(f"     Slide {si+1}: {sc[:60]}...")

    generated = []
    for i, slide in enumerate(slides, 1):
        fname = f"bg_slide{i}.png"
        fpath = out / fname

        # Skip if already exists (allow re-runs)
        if fpath.exists():
            print(f"  ⏭️  Skipping slide {i} (already exists)")
            generated.append(str(fpath))
            continue

        scene = scene_pool[i - 1] if i - 1 < len(scene_pool) else scene_pool[-1]
        prompt = generate_bg_prompt(slide, scene, i)
        print(f"  🎨 Generating background for slide {i}/{total}...")

        retries = 2
        for attempt in range(retries + 1):
            try:
                response = client.models.generate_content(
                    model="gemini-3-pro-image-preview",
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        response_modalities=["TEXT", "IMAGE"],
                        image_config=types.ImageConfig(
                            image_size=args.resolution
                        )
                    )
                )

                image_saved = False
                for part in response.parts:
                    if part.inline_data is not None:
                        image_data = part.inline_data.data
                        if isinstance(image_data, str):
                            import base64
                            image_data = base64.b64decode(image_data)

                        image = PILImage.open(BytesIO(image_data))

                        # Resize/crop to exactly 1080x1350
                        iw, ih = image.size
                        scale = max(1080 / iw, 1350 / ih)
                        new_w, new_h = int(iw * scale), int(ih * scale)
                        image = image.resize((new_w, new_h), PILImage.LANCZOS)
                        left = (new_w - 1080) // 2
                        top = (new_h - 1350) // 2
                        image = image.crop((left, top, left + 1080, top + 1350))

                        if image.mode != "RGB":
                            image = image.convert("RGB")
                        image.save(str(fpath), "PNG")
                        image_saved = True
                        break

                if image_saved:
                    print(f"  ✅ {fname}")
                    generated.append(str(fpath))
                    break
                else:
                    print(f"  ⚠️  No image in response for slide {i}, attempt {attempt+1}")
                    if attempt < retries:
                        time.sleep(3)

            except Exception as e:
                print(f"  ❌ Error slide {i}, attempt {attempt+1}: {e}", file=sys.stderr)
                if attempt < retries:
                    time.sleep(5)
                else:
                    print(f"  ⚠️  Failed to generate bg for slide {i}, will use solid fallback")

        # Rate limit: wait between API calls
        if i < total:
            time.sleep(2)

    print(f"\n🖼️  Generated {len(generated)}/{total} backgrounds → {args.output}")
    return generated


if __name__ == "__main__":
    main()
