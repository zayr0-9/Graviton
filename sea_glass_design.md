# Sea Glass UI — Design Guide

**Status: approved visual direction.** This guide records the current, user-approved sea-glass study. Preserve this treatment when extending the component family; do not return to earlier glossy, bulky, or highly transparent versions.

**Working reference:** [sea-glass.html](design-previews/sea-glass.html). The latest screenshot supplied with this guide request is the visual acceptance reference. The screenshot is conversation-attached, not a checked-in image. The HTML is currently in a Git-ignored preview directory; this guide is intentionally at the repository root so the design decisions can be versioned independently.

## 1. The intended feeling

**Small pieces of sea-worn, coloured glass resting on a quiet surface.**

The glass is translucent, lightly granular, softly rounded, and coloured through its thickness. It is neither a transparent sheet nor an opaque plastic button. It lets background colour and diffuse light pass through while scattering fine detail.

The approved screenshot shows:

- An off-white, slightly warm background.
- A cornflower search bar, orchid primary button and composer, and honey icon button and collection panel.
- Fine, restrained surface grain that is apparent on inspection rather than visually busy.
- Soft internal illumination, without a permanent white outline or bevel.
- Muted, colour-related text rather than generic black on every surface.
- Compact component interiors surrounded by generous page-level whitespace.
- Grounding shadows that carry more neutral depth than coloured glow.

Those colour assignments are an approved example, not fixed meanings. All specimens can be recoloured independently. The HTML's initial assignments differ from the screenshot because the screenshot reflects interactive colour choices; documenting the screenshot does not change those initial choices.

### Non-negotiable principles

1. **Translucent, not see-through:** sense the scene behind the material; do not make underlying text legible.
2. **Texture belongs to the material:** static, fine grain; never animated television noise.
3. **No fake glossy outline:** no continuous bright rim, white stroke, hard bevel, or chrome-like edge.
4. **Lighting stays restrained:** a static internal underglow plus a small pointer-responsive edge segment.
5. **Compact, not padded-out:** preserve the reduced padding and text sizes.
6. **Content stays crisp:** do not lower opacity or blur the entire component.
7. **Motion communicates interaction:** small hover/press feedback, anchored dropdowns, no ambient wobble or dramatic tilt.

## 2. Approved material defaults

These are the current baseline, not suggested ranges.

| Setting | Default | Implementation |
| --- | ---: | --- |
| Fine grain | **8%** | `--grain: .08` |
| Surface wear | **4%** | `--coarse: .04` |
| Transmission control | **54%** | `--body-opacity: .46` |
| Backdrop scatter | **24px** | `blur(24px)` |
| Backdrop saturation | **1.22** | `saturate(1.22)` |
| Light strength, light theme | **67%** | `--light-gain: .67` |
| Light strength, dark theme | **16%** | `--light-gain: .16`, applied by theme JS |
| Pointer influence distance | **160px** | Distance from the component rectangle |
| Local edge-highlight feather radius | **48px** | Radial mask on the lighting layer only |
| Static underglow alpha, light / dark | **.24 / .16** | `--underglow-alpha` |

**Transmission is an artistic density control, not measured optical transmittance.** The base body opacity is `1 − transmission / 100`, but several gradients and backdrop filtering combine in the final material. A setting of 54% does not mean every pixel is exactly 54% transparent.

The theme toggle updates the light-strength slider and its readout together. Manual light-strength changes are remembered separately for light and dark mode during the current page session. There is no persistence across reloads in the study.

## 3. Material construction

### Layer model

```text
Foreground text, icons, inputs, and controls — crisp and unaffected
Static fine grain + static fine surface-wear texture
Localized, masked inset lighting — reacts to pointer proximity
Tinted body + cloudy center + soft internal lower underglow
Blurred, slightly saturated backdrop — colour passes through, detail scatters
Neutral grounding shadows + very restrained tinted shadow
Page or components underneath
```

This is an appearance approximation using HTML, CSS, embedded SVG textures, and small JavaScript interactions. It is not physical refraction, ray tracing, or a WebGL material.

### Body and internal light

Use a transparent component border for sizing, not a visible decorative stroke. Keep the static illumination within the body:

```css
background:
  radial-gradient(
    ellipse 90% 100% at 50% 110%,
    rgba(var(--glow), var(--underglow-alpha)), transparent 85%
  ),
  radial-gradient(ellipse at 50% 48%, rgba(var(--tint), .28), transparent 78%),
  radial-gradient(ellipse at 72% 90%, rgba(var(--deep), .19), transparent 68%),
  linear-gradient(
    168deg,
    rgba(var(--tint), var(--body-opacity)),
    rgba(var(--glow), calc(var(--body-opacity) * .78))
  );
backdrop-filter: blur(24px) saturate(1.22);
-webkit-backdrop-filter: blur(24px) saturate(1.22);
```

The lower underglow is broad and static. It is not a moving spotlight. Preserve the center's cloudy pigment and slight depth variation without adding a bright upper rim.

If backdrop filtering is unsupported, fall back to a solid tinted base. A slightly opaque fallback is preferable to sharp underlying text showing through.

### Two-scale texture

Both textures are embedded SVG data URLs; no downloaded image or continuously generated noise is needed.

| Texture | Source | Display scale | Blend | Default opacity |
| --- | --- | --- | --- | ---: |
| Fine grain | `feTurbulence`, fractal noise, frequency `.86`, 3 octaves, seed `17`, stitched, desaturated | `180px × 180px` tile | `soft-light` | `.08` |
| Surface wear | Fractal noise, frequency `.19`, 3 octaves, seed `8`, stitched, desaturated, discrete levels `0 .2 .65 1` | **`80px × 80px`** display tile from a 240px SVG | `overlay` | `.04` |

Surface wear was deliberately made three times finer than the original 240px display tile. Do not restore the coarse, visibly mottled texture. Its purpose is tiny irregularities in the finish, not large pits or stains.

Texture and light layers must be noninteractive and remain behind foreground content. Do not put noise over the text. Do not apply `filter: blur(...)` to the entire surface as a substitute for backdrop scattering.

### Shadow recipe

Retain this restrained grounding stack:

```css
box-shadow:
  1px 4px 5px -2px rgba(40, 56, 49, .04),
  5px 12px 12px -9px rgba(37, 49, 43, .10),
  2px 8px 12px -11px rgba(var(--tint), .14);
```

This softer recipe supersedes the earlier, stronger shadow. The V2 silhouette shadows follow the same reduction: neutral alpha `.10` at `(4px, 8px)` with `6px` blur, tint alpha `.09` at `(1px, 5px)` with `5px` blur. Small badges and progress fills have no exterior shadow; chips and control marks use only faint local grounding. Internal underglow and pointer edge lighting are unchanged.

The first two layers provide neutral contact and directional depth. The last is a small hint of transmitted colour. Its blur, offset, negative spread, and opacity have been reduced repeatedly on purpose. Do not replace it with a wide coloured halo.

There are no static bright inset bevels in the main material. Inner controls and selected list rows also avoid decorative outline/bevel treatments. Accessibility focus indicators and selected colour-swatch indicators are separate from material styling.

## 4. Colour system

Every colour has four coordinated values: body tint, depth tint, glow tint, and foreground ink. Change them together. Do not recolour only the background while leaving an incompatible foreground.

### Light theme

| Variant | CSS class | Body RGB | Depth RGB | Glow RGB | Ink |
| --- | --- | --- | --- | --- | --- |
| Seafoam | `.glass` baseline | `148, 211, 188` | `89, 157, 132` | `213, 250, 220` | `#244d42` |
| Cornflower | `.blue` | `154, 181, 241` | `98, 132, 203` | `184, 230, 250` | `#2c487b` |
| Orchid | `.pink` | `232, 166, 228` | `177, 108, 186` | `250, 206, 236` | `#754580` |
| Honey | `.amber` | `237, 193, 111` | `193, 144, 52` | `255, 233, 172` | `#725223` |
| Coral | `.coral` | `245, 168, 161` | `207, 111, 107` | `255, 218, 205` | `#8e3938` |

### Dark theme

| Variant | Body RGB | Depth RGB | Glow RGB | Ink |
| --- | --- | --- | --- | --- |
| Seafoam | `41, 91, 77` | `10, 42, 35` | `64, 123, 103` | `#d8efe4` |
| Cornflower | `46, 67, 112` | `20, 33, 66` | `68, 113, 145` | `#e0eaff` |
| Orchid | `98, 56, 108` | `47, 26, 57` | `133, 86, 130` | `#f2ddf4` |
| Honey | `118, 84, 37` | `61, 42, 17` | `151, 119, 65` | `#f7e7c8` |
| Coral | `126, 64, 63` | `67, 32, 32` | `157, 99, 85` | `#ffe3dc` |

### Page and inner surfaces

| Token | Light | Dark |
| --- | --- | --- |
| Page | `#f6f7f2` | `#101a1e` |
| Page ink | `#263d3b` | `#e0ece7` |
| Muted text | `#677773` | `#a1b6b0` |
| Separators | `#dfe5dc` | `#304146` |
| Inner control fill | White at `.30` alpha | `224,240,247` at `.075` alpha |
| Button keyboard focus | `#386a78` | `#a6d8dc` |

Dark mode is a separate tinted palette, not a black overlay or an inversion filter. Keep the fine grain and translucency, but reduce the internal glow and pointer strength. The page starts from system preference until manually overridden.

### Colour selection

- Each of the six specimens has its own set of five swatches.
- The two main buttons have independent palettes.
- The composer and model list always share a colour.
- The collection preview and collection modal always share a colour.
- The draggable specimen is independently recolourable.
- Swatches expose names and selected state; selection is not communicated through colour alone.
- Palette controls are study tools. They need not appear next to every component in a production interface.

## 5. Geometry, density, and typography

### Library direction: smooth by default, organic by choice

The intended destination is a reusable component library; the HTML remains a demonstration, not the library implementation. **Smooth sea-glass surfaces are the default.** The “V2 / A barely imperfect edge” treatment is an optional shape variant, not a replacement or a new default for the component family.

- Opting into organic edges must be explicit. Theme, colour, hover, or pointer lighting must never enable deformation implicitly.
- The demo's **Organic edges (optional)** checkbox starts unchecked and affects only its V2 specimens. Unchecking restores a smooth silhouette while retaining the tuning values for the next comparison.
- For the future library, expose this as a per-component capability, conceptually `edgeStyle: 'smooth' | 'organic'`, defaulting to `'smooth'`. This is a proposed contract, not an API that exists today. An application may expose it as an end-user preference.
- Keep shape independent of colour, material density, theme, content, and behavior. Both variants share the same material and foreground components.
- Organic tuning uses deviation (currently 0.5px), detail density (14), width variation (75%), and a stable seed. These are opt-in experiment starting values, not mandatory material defaults.
- The optional contour uses seeded, unevenly spaced smooth noise, weighted toward broad thickness changes across the width. It is not a periodic sine-wave scallop or a continuously wobbling surface.
- Deform only the material silhouette, its matching shadow, and its localized edge light. Never deform text, layout, controls, or hit areas.
- A future library should not initialize contour-generation work for ordinary smooth components. The demo currently renders its V2 smooth comparison through the same path generator at zero deviation; this does not prescribe production architecture.

The original approved smooth specimens remain the baseline for the geometry below.

**Use whitespace around the components, not excessive padding inside them.** The screenshot's spacious composition must not be interpreted as permission to enlarge every control.

All dimensions below are **CSS pixels**. Most record the working reference; the anchored-popover row records the compact target now applied to the demo model menu. Screenshot pixels can differ with display scale or browser zoom; do not double CSS sizes to match a high-resolution screenshot.

| Component | Approved compact geometry |
| --- | --- |
| Search | Padding `11px 16px`; gap `10px`; radii `24px 26px 23px 25px`; text `15px` desktop, `16px` small screens |
| Primary button | Minimum height `44px`; padding `10px 18px`; gap `8px`; radii `23px 25px 22px 24px`; text `14px`, weight `550` |
| Round action | `44px × 44px`; radii `48% 52% 49% 51%`; icon `19px` |
| Composer | Padding `14px 16px 12px`; radii `24px 27px 23px 26px`; textarea `16px`, line height `1.5`, minimum height `44px` |
| Composer toolbar | Gap `8px`; top margin `8px`; icons in `34px` controls on desktop |
| Model selector | Minimum height `34px`; padding `6px 11px`; text `12px`; chevron `14px` |
| List panel | Padding `16px`; radii `21px 24px 22px 25px` |
| List row | Padding `8px 10px`; gap `10px`; radius `12px`; `4px` separation |
| Anchored popover / model options — revised library target | Preferred width `260px`, up to `280px` for descriptions; surface padding `6px`; radius `14px`; viewport gutter `12px`; see compact-popover contract below |
| Collection dialog | Width up to `400px`; padding `16px`; radii `23px 26px 22px 25px` |
| Floating specimen | Width up to `270px`; padding `16px 18px`; radii `23px 26px 22px 25px` |

Corner asymmetry should be barely noticeable. It evokes worn glass without turning functional controls into irregular blobs.

Use the system sans-serif stack from the reference: `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`. Body baseline is `15px/1.5`; panel titles are `16px`, weight `550`; row titles are `14px`, weight `550`. Supporting text is quieter, not all-caps or excessively bold. **Lucide is the default icon family.** Use official Lucide paths on a `24 × 24` viewBox, rounded caps/joins, `currentColor`, and the study's restrained `1.7` stroke. Typical display sizes remain 14–22px. Do not mix hand-drawn symbols or Unicode pictograms into the icon set. Decorative icons are hidden from assistive technology; icon-only buttons need accessible labels. The standalone HTML embeds the selected SVG paths and license notices, so no CDN, runtime icon package, or network request is needed.

The study uses two columns with a `64px` gap, collapsing to one at `740px`. This is a specimen layout, not a required application shell.

## 6. Pointer-responsive edge light

### What it should look like

A **short, softly feathered segment inside the edge** catches light as the pointer approaches. It can illuminate part of a corner, not the entire corner, side, or circumference. No luminous circle should travel through the middle of the component.

The material background and exterior shadows stay static. Only the dedicated `.edge-light` layer responds.

### Implementation contract

1. Track the pointer at document level so nearby components respond before being hovered.
2. Measure distance to the nearest point of each component's rectangle, not its center.
3. Within **160px**, compute smooth proximity falloff: `p = clamp(1 - distance / 160, 0, 1)`, then `p * p * (3 - 2 * p)`.
4. Normalize pointer direction relative to component width and height. Invert the direction for the inset-shadow offset, with a maximum vector magnitude of **9px**.
5. Reduce the directional response near the exact center, where direction is ambiguous.
6. Clamp the pointer's local coordinates to the component bounds for the highlight-mask center.
7. Smooth position and strength using `1 - exp(-frameDelta / 85)`; start new patches at the pointer rather than sweeping from the center.
8. Apply the light only through the separate decorative span:

```css
.edge-light {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  z-index: -1;
  box-shadow: inset var(--edge-x) var(--edge-y) 14px -6px
    rgba(255, 255, 255, calc(var(--light-strength) * var(--light-gain) * .65));
  mask-image: radial-gradient(
    circle 48px at var(--edge-spot-x) var(--edge-spot-y),
    #000 0%, rgba(0, 0, 0, .75) 30%, transparent 100%
  );
}
```

Also supply the `-webkit-mask-image` declaration as in the reference. The mask applies **only to the lighting layer**, never the whole component. The 48px feather radius is not the 160px pointer influence distance; these control different things.

Use a single animation-frame loop, batch geometry reads before style writes, skip hidden/offscreen surfaces, and stop scheduling frames when settled. Reset on window blur, pointer cancellation, hidden document, or disabling the effect. On touch/coarse pointers or reduced motion, keep only the static internal underglow.

The reference initializes its surface list once. A production component system must register/unregister newly mounted surfaces and clean up listeners/observers; copying the initialization literally would miss dynamically created components.

## 7. Interaction and motion

### Hover and press

- Fine-pointer hover: `translateY(-1px)` and brightness `1.035`.
- List-row hover: `translateX(2px)` instead of a lift.
- Press: `translateY(1px) scale(.97)` and brightness `.98`.
- Hover duration: **180ms**; press duration: **90ms**.
- Easing: `cubic-bezier(.22, 1, .36, 1)`.
- Quick clicks and keyboard activation receive a short press-state cleanup timer.
- No hover transforms on touch. Reduced motion removes transforms and transitions.

### Anchored popover component class — compact by default

**Required reusable component category:** `SeaGlassPopover`, with root styling class `.sea-glass-popover`. The standalone demo now uses this class and a `.sea-glass-popover-surface` for the original and V2 AI composer model pickers. An exported framework/library component API is still future work.

This is the class of overlay shown beside the AI composer in the latest reference screenshot: a surface that opens **in place, attached to its trigger**, not at the center of the screen. Although it may be informally called an “in-place modal,” its default behavior is a **non-modal anchored popover**. Keep true blocking dialogs as a separate `SeaGlassDialog` category.

**The screenshot establishes placement and material, not approved density.** Its large “Choose your pace / A mind for every moment” header, generous row spacing, footer explanation, and panel padding are too bulky for the intended library. This section explicitly supersedes the earlier model-popover sizing. The demo model picker now applies these compact targets: a 260px panel, 6px surface padding, 14px radius, and three compact two-line options without the old header or footer.

#### Structure and reusable responsibilities

```text
Trigger (model button, filter button, action button, etc.)
└── Anchored popover surface — shared material and placement behavior
    ├── Optional compact heading / close action
    ├── Content slot — options, actions, filters, or small form controls
    └── Optional compact footer — only when functionally necessary
```

- Reuse the sea-glass material, theme, tint, localized edge light, and motion. Do not build a visually unrelated menu surface.
- Use smooth edges by default. Organic edges remain a separate explicit opt-in, not implied by opening a popover.
- Expose anchor/trigger, open state, open-state callback, preferred placement, alignment, accessible label, tint, and content slots as library responsibilities. Exact framework API remains to be designed.
- Do not bake AI-specific headings or model options into the surface primitive. A model-picker specialization supplies its selection logic and content.
- Match the triggering component's tint by default; allow an intentional override.
- The popover must not alter the composer height or shift surrounding layout when it opens.

#### Compact geometry: library targets

| Element | Target (CSS px) |
| --- | --- |
| Panel width | Prefer `260px`; allow up to `280px` for secondary descriptions; cap at viewport width minus `24px` |
| Panel padding | **`6px`**, reduced from the earlier demo's `14px` model-panel padding |
| Panel radius | `14px`; softly rounded, not an oversized pill |
| Trigger-to-panel gap | `6px` |
| Viewport gutter | Minimum `12px` on each side |
| Optional heading | One line, `12px`, weight `550`; padding `4px 6px 6px`; no eyebrow/title stack |
| Single-line option | Minimum height `32px`; padding `6px 8px`; gap `8px` |
| Two-line option | Natural height around `44–48px`; padding `6px 8px`; no artificial extra vertical spacing |
| Row separation | `2px`; radius `8px` |
| Primary row label | `13px`, line height `18px`, weight `500–550` |
| Optional description | `11px`, line height `15px`; `2px` below label; wrap only when needed |
| Leading icon / selection mark | `14–16px`; decorative colour dot `6–8px` |
| Optional footer | `11px`; padding `6px 8px`; no repeated instructional prose |
| Optional close action | `28px` desktop hit area; `44px` on coarse pointers |

These are compact defaults, not fixed-height clipping rules. Let text expand with localization, font scaling, or necessary descriptions. On coarse pointers, expand option hit areas to at least `44px` without restoring large header/footer gaps.

For three choices, aim for roughly **`112px` total panel height with single-line rows** or **`148–160px` with short two-line rows**, excluding any genuinely needed heading. These are density guides, not hard height limits. Reduce structure and padding before shrinking text below these sizes.

#### AI composer model-picker content

- Prefer the three model choices directly; an optional short “Model” heading is enough.
- Remove the two-level marketing header: “Choose your pace” and “A mind for every moment.”
- Remove the demo-only explanatory footer from the reusable model picker. If the demo needs a disclaimer, place it outside the popover rather than padding out the overlay.
- Keep a quiet filled selected row and a checkmark; do not add a decorative outline.
- Descriptions are optional. Use concise descriptions when they help the choice, not as mandatory padding-producing content.
- Keep the composer itself compact using its existing sizing. This new class is for the anchored options surface, not a reason to wrap the chat input in another padded card.

#### Placement, behavior, and accessibility

The model selector opens a **local anchored list**, never a centered blocking modal. Prefer below-start placement; flip above when needed and shift within the viewport. Keep the panel near its trigger rather than centering it as a collision fallback.

- Reposition on scroll, resize, anchor resize, and content-size changes. Constrain height and scroll the list when neither side has enough room.
- Render outside clipping ancestors using an appropriate top-layer/portal mechanism; the visual connection to the trigger must remain intact.
- Do not dim the page, add a blocking backdrop, lock page scrolling, or trap focus for this non-modal primitive.
- Dismiss on Escape, outside interaction, and focus leaving trigger plus content. Selection may close a picker; form/filter content can opt to stay open.
- Restore focus to the trigger on Escape or selection. Outside-click dismissal must not steal focus from the user's next target.
- Use semantics appropriate to the content: a model choice can be a radio group or a properly implemented listbox; command actions can use menu semantics; mixed interactive content can be a non-modal dialog. A styling class must not force every use into `role="menu"` or `aria-modal="true"`.
- Provide an accessible name even if the visible header is omitted. Reflect state with `aria-expanded` and connect the trigger to its surface.

### Optional nearby colour reflection — per component

Every `.glass` surface supports optional component-to-component light. It remains **off by default**; the floating specimen and original composer retain their enabled demo settings. Each specimen palette includes a reflection checkbox and strength control. Unrepresented surfaces (badges, chips, inline notes, etc.) can opt in through the same attributes/API. Both a source and receiver must opt in.

```html
<div class="glass blue" data-reflection="true" data-reflection-strength="93">…</div>
```

For existing or newly inserted glass elements, the standalone demo exposes:

```js
seaGlassReflection.set(element, { enabled: true, strength: 93 });
seaGlassReflection.set(element, { enabled: false });
```

The demo API defaults to `enabled: false` and inherits the current theme's default when `strength` is omitted; finite numeric strengths are clamped to 0–100. A zero-strength surface neither emits nor receives reflection. Missing `data-reflection-strength` inherits the lab's **Default strength** setting; an explicit value is independent of that setting. Strength limits both emitted and received reflection: each pair uses the **lower** of the source and receiver settings. A component at 1% therefore cannot cast a 93% reflection onto its neighbour. Equal strengths are not multiplied together; there is no recursively amplified source light. Dynamically inserted elements must be registered through the API. This is a prototype contract, not an exported framework component.

- [ ] **TODO — standardize reflection strengths:** replace raw numeric values in the future public component API with named strength categories backed by shared design tokens. Choose names and calibrated light/dark mappings after visual tuning; do not treat today's numbers as finalized categories.

- The experiment starts enabled, with a **Nearby reflection (global)** master checkbox in the top material-control bar. Switching it on enables every registered component; switching it off disables every registered component. Individual strengths are preserved. It displays a mixed state when only some components are enabled (including the initial two-component demo). Per-component toggles and API updates synchronize the global checkbox. Range and default-strength tuning remain beside the floating specimen. Range defaults to **48px** (tunable 16–80px); **Reflection strength** defaults to **38% in light mode** and **93% in dark mode** (tunable 0–100%), independently of pointer-light strength. Its alpha is proximity × min(source strength, receiver strength) × `.65` × theme gain, with no pointer-strength multiplier. Theme gain is **2 in light mode** and **1 in dark mode**; CSS alpha saturates at 1. The shorter range, distance falloff, and borrowed colour remain unchanged; perceived brightness can still differ from mouse lighting.
- Measure the gap between rectangle edges, not centres. Use facing-edge midpoints or closest corners and a smooth proximity falloff. Fade out if the surfaces intersect; do not pretend to model overlapping/occluded light transport.
- Each surface receives the other surface's base tint mixed with 30% white. Theme and palette changes update the source colours. Never feed reflected output back into either source.
- Treat the neighbour as an area source, not a point: use a separate softly feathered elliptical inset patch. Along the shared facing edge, its radius is half the shared span plus a 40px shoulder, bounded to 64–200px; across that edge it is 44px. Diagonal neighbours use 64px radii on both axes. Smooth radius changes with position/strength changes. Use 26px inset blur with −8px spread and mask stops at 0%, 25%, 65%, and 100% to diffuse the light without an external halo. The mouse retains its independent 48px mask, 14px blur, and 160px range. On opted-in surfaces, mouse light uses the receiving surface's pale tint instead of white. Opted-out surfaces retain the original pointer treatment.
- Keep reflection and pointer strength independent. The pointer's Light strength slider (including zero), per-theme strength defaults, and Responsive light checkbox do not change or disable nearby reflection. Reflection remembers its default-strength adjustments separately for light and dark during the page session. Theme changes update inherited values and their controls, but preserve explicit per-component overrides; its own zero setting or checkbox disables it. Reflection can respond to touch/keyboard dragging without a mouse pointer. Reduced motion, hidden documents, and window blur disable reflection; focus/visibility restoration recomputes it.
- Keep **up to four independent source slots per receiver**, keyed by source identity rather than rank. Each retains its colour, facing position, and diffused extent. Missing sources fade out in place; newcomers fade in at their own edge. At capacity, a newcomer must be over **15% stronger** than the weakest retained contribution to replace it. Fade the old slot fully before reusing it; never recolour a visible patch or allocate a fifth layer.
- Cap the **sum of final reflection alpha at 1 per receiver**, proportionally scaling contributions when necessary. Include `.65` and the light/dark theme gain in the budget. Budget both target strengths and interpolated output, including departing sources, to prevent transition spikes. Pointer lighting remains separate.
- Ignore self, ancestor/descendant pairs, overlapping bounds, hidden and offscreen surfaces. Organic V2 slots share the existing contour and clip, not a rectangular reflection overlay. Layers are allocated lazily and reused, bounded to four per receiver.
- Index visible opted-in rectangle bounds in every occupied cell of a spatial grid; query range-expanded bounds, deduplicate candidates, and calculate each pair once for both directions. Clip grid indexing to the viewport plus influence distance. Cache colours until palette/theme changes and neighbour geometry until invalidated by movement, scroll, resize, visibility or layout changes. Read geometry before paint; settling frames reuse cached pairs. Dense clusters still have quadratic worst-case candidate cost, but painting is bounded. Only schedule frames on changes or while the short smoothing settles. Stationary neighbours hold a steady patch; no ambient loop, extra exterior glow, stronger shadow, or silhouette deformation is introduced.

Drag the floating specimen close to an edge of the original composer without overlapping it to compare the two source colours. This is an artistic approximation, not physical global illumination. Manual visual tuning and physical-device checks remain necessary.

### Standalone specimens: popover and scroll list

The HTML also presents **09 / Standalone popover** and **10 / Scroll list** independently of the composer. The honey popover sorts the eight-piece shoreline collection by recent, name, or oldest; it does not change model selection. Both specimens have independent colour palettes and inherit the shared material controls and light/dark theme. Their silhouettes stay smooth.

The `.sea-glass-list` prototype uses a 12px inset, the existing softly asymmetric panel corners, a stationary compact heading, and a native scrolling region capped at 260px. Rows have at least 52px hit areas, wrapping copy, and a check plus soft fill for the selected piece. The selected label remains below the scroll region. Use list semantics and actual buttons; this is not an ARIA listbox.

Keep scrolling separate from the outer glass shell so the material, edge lighting, heading, and shadows remain stationary. This remains a prototype category for a future `SeaGlassList`, not an exported library component.

### Shared sea-glass scrollbar

**Approved treatment:** reuse `.sea-glass-scroll` on the actual scrolling element, not its outer glass shell. The demo applies it to the scroll-list viewport and both original and V2 composer textareas. Do not create a separate chat-input scrollbar style.

| Property | Treatment |
| --- | --- |
| Rail size (WebKit/Blink) | `12px` wide/high, with transparent `3px` insets for a slender visible rail and thumb |
| Shape | `20px` track/thumb radius; `4px` track end margins; thumb minimum height `36px` |
| Light theme | Thumb `rgba(var(--deep), .58)`; track `rgba(var(--deep), .09)` |
| Dark theme | Thumb `rgba(var(--glow), .8)`; track `rgba(var(--glow), .12)` |
| Thumb material | Vertical gradient from `rgba(var(--glow), .65)` to the thumb colour, with the shared embedded grain texture at `180px × 180px` |
| Hover | Solid theme-specific thumb colour; no extra glow or movement |
| Layout | `scrollbar-gutter: stable` reserves space where supported; no simulated overlay track |
| Firefox fallback | Standard `scrollbar-width: thin` and matching `scrollbar-color`; native thumb geometry |
| Forced colours | System colours: `ButtonText` thumb and `Canvas` track in WebKit/Blink; automatic scrollbar colours elsewhere |

The scrollbar inherits the component's tint, including palette changes. Native scrolling retains wheel, touch, keyboard, and scrollbar-drag behavior. Platform overlay-scrollbar visibility still follows browser/OS preferences; do not replace it with an inaccessible simulated scroll track merely to force visibility.

For the composer, keep the textarea transparent, vertically resizable, and within its existing `44px` minimum / `240px` maximum height. Long messages scroll inside the textarea while the material shell and toolbar stay stationary. Preserve text editing, selection, caret behavior, and the existing border-free field treatment. Adding the scrollbar must not enable organic edges or change the outer component geometry.

### Everyday component specimens (11–16)

These extend the current material study, not a finalized component API. Smooth geometry remains the default. Apply the full material to meaningful surfaces; keep supporting text, tab content, secondary actions, badges, and dense rows quieter.

- **Form kit:** a labelled text input with a compact 15–17px rounded shell, help/error text, a stronger icon and underlined label for keyboard focus instead of an input border. Native checkbox and radio inputs retain native keyboard behavior behind custom glass marks. The switch is a native checkbox with `role="switch"`, a clear thumb position, and an On/Off readout. Labels have at least 44px hit height. The select uses the compact anchored listbox: arrows/Home/End/typeahead move focus, Enter/Space commit, Escape cancels, and Tab leaves without trapping focus. Save validates the name and shows a local-demo confirmation; it does not persist preferences.
- **Tabs and segmented control:** tabs reveal associated panels with roving keyboard focus and a measured active inset. Both the tab bar and segmented-control shell use the full shared sea-glass material, not a flat translucent fill; the active inset is quieter to avoid stacking glass on glass. The separate radio-style segment changes preview row density. Use 250ms tab motion with resize synchronization and reduced-motion support, not motion on the labels or entire content panels.
- **Tooltip and action menu:** the tooltip is a short hover/focus hint with Escape dismissal and a hover bridge. Essential information remains visible elsewhere. The menu reuses the 260px popover and Lucide command icons with menu semantics, arrow navigation, Home/End, typeahead, dismissal, and trigger focus restoration. Its actions are explicit local previews, not destructive operations.
- **Toast and inline alert:** a quiet, stationary inline note uses an icon plus text, not colour alone. Toasts announce through the existing polite status region, never steal focus, and auto-dismiss after six seconds unless hovered/focused. Explicit dismissal restores focus only if focus was inside the toast. The toast surface uses the same full glass recipe as the floating specimen. Its animation wrapper must have `filter: none` (not even `blur(0)`) and must not declare `will-change: opacity` or `will-change: filter`, which establish a backdrop root and prevent the child material from sampling the page. Retain 350/250ms arrival/departure with crisp text; disable motion when requested.
- **Badges and chips:** badges describe status; chips have labelled remove buttons and a restore action. Avoid strong exterior shadows on either. Removing a chip moves focus to a remaining chip or the restore control.
- **Progress:** a 10px determinate track, shared grain-tinted fill, visible percentage, and progressbar semantics. Advance/reset controls demonstrate the state; there is no fake network work, automatic loop, or shimmer.

The new form, navigation, menu, feedback, and progress specimens have independent palettes. Fixed semantic examples such as the informational note and mixed status badges retain intentional tints. All share theme/material settings and Lucide icons. Keyboard, touch, forced-colour, reduced-motion, and long-text behavior require production validation beyond the prototype checks.

### Model options motion

The compact popover retains the existing interaction rhythm; reduced padding does not imply more dramatic movement.

Keep the transitions.dev dropdown treatment:

- Open: `250ms`, scale `.97 → 1`, opacity `0 → 1`.
- Close: `150ms`, scale toward `.99`, opacity toward `0`.
- Origin matches whether the list opens above or below.
- Easing: `cubic-bezier(.22, 1, .36, 1)`.
- Close-state cleanup and reduced-motion support are required.
- Escape, outside interaction, focus leaving the group, and selection dismiss the list.
- Selection/Escape restore focus appropriately; arrow keys navigate the model radio group.

The collection dialog remains a true modal, with the same 250/150ms open/close rhythm and a `.96` scale. Do not apply its centering or backdrop behavior to the model list.

### Draggable specimen

The floating card is a material-inspection tool: users can drag it over other components to inspect scattering, overlap, and live translucency.

- Drag anywhere on the card with pointer capture; preserve the initial grab offset.
- Keep it within a `12px` viewport gutter.
- Release leaves it in place; cancellation/lost capture/window blur ends the drag.
- Arrow keys move `10px`; Shift increases the step to `40px`.
- Escape or **Return to tray** restores its original layout position.
- Retain the actual backdrop-filtered surface while moving; do not replace it with an opaque drag image.
- It floats above ordinary page components. Native popovers and modal dialogs still sit above it in the browser top layer.

## 8. Focus, accessibility, and touch

### General rule: pointer interaction does not add a focus border

Clicking, tapping, or dragging a component must not introduce a decorative focus outline, border, or extra focus shadow. Keep the normal material edge unchanged. This rule is about **pointer modality**, not removing accessible keyboard focus: use `:focus-visible` or an equivalent modality-aware treatment, never a blanket removal of all focus indicators.

The floating specimen explicitly suppresses its outline after pointer-triggered programmatic focus. Keyboard interaction restores its visible focus indicator; leaving the component clears the pointer-only suppression. Keep keyboard movement and Escape-to-tray behavior intact. Other components should use the same distinction when pointer handlers call `.focus()`.

Where a border-free keyboard treatment is required (such as text fields), supply an effective non-border cue rather than making focus invisible.

The approved visual request explicitly removes both the inner input outline and the rounded container focus outline from the search field and composer. Do not reintroduce the rejected rectangular border as a default browser effect.

This does **not** mean removing keyboard focus from every control:

- Buttons, swatches, and the draggable card retain visible keyboard-focus indicators.
- Inputs retain labels and a visible caret; the search icon strengthens on `:focus-visible`.
- **Known production gap:** the current composer focus rule uses the same fill as its normal send-button state, so it does not provide a distinct additional cue. Before production, validate keyboard orientation and add an effective non-border cue without restoring the rejected outline.
- Keep model selection semantics, selected swatch states, accessible icon-button names, and native modal focus handling.
- Current coarse-pointer main controls expand to `44px`; swatches are `36px`. Review target sizes and spacing against the product's accessibility requirements rather than assuming the study is certified.
- Test contrast over actual backdrops in both themes and all colours. Tint, alpha, and noisy surfaces make contrast backdrop-dependent.
- Honor reduced motion; lighting is supplemental and must never be necessary to identify or operate a control.

## 9. Rejected directions — do not regress

| Avoid | Use instead |
| --- | --- |
| Transparent rectangles with readable content behind them | Tinted, strongly scattered transmission |
| Permanent white outline or shiny bevel | Border-free body with static internal underglow |
| A bright moving spotlight across the face | Local masked response inside a short edge segment |
| Lighting the entire side or corner | 48px feathered light mask |
| Wide coloured shadow halos | Tight, low-opacity tint beneath neutral depth shadows |
| Coarse, blotchy surface noise | Fine stationary grain and finely scaled surface wear |
| Large padding, oversized type, swollen controls | The compact geometry in this guide |
| Centered model-picker modal | Trigger-anchored list |
| Whole-component opacity or blur | Layer-specific translucency and backdrop filtering |
| Big bounces, tilt, continuous shimmer | Small hover/press and short open/close transitions |
| Dark mode as a gray/black overlay | Dedicated dark pigments and theme-specific light strength |

## 10. Review checklist

Use the current screenshot for the resting light-theme appearance and the HTML for interactions.

- [ ] Fine grain 8%, surface wear 4%, transmission 54% on a fresh load.
- [ ] Light strength 67% in light mode and 16% in dark mode; slider/readout stay synchronized.
- [ ] No static glossy perimeter, hard bevel, or visible decorative border on the main material.
- [ ] Background colour passes through; background text is not sharply readable.
- [ ] Foreground text and icons are crisp; grain remains still.
- [ ] Shadow provides depth without a conspicuous coloured halo.
- [ ] Pointer affects only a small edge segment and fades smoothly with distance.
- [ ] Touch/reduced motion retain an attractive static surface.
- [ ] Compact controls remain comfortable to use; screen scaling has not inflated CSS dimensions.
- [ ] All five palettes work in both themes, with related popovers colour-matched.
- [ ] Model list stays anchored and supports keyboard navigation/dismissal.
- [ ] Library popovers use the compact targets: 6px panel padding, short rows, optional one-line header, and no demo-prose footer.
- [ ] Opening a popover does not center it, dim the page, resize the composer, or impose modal focus trapping.
- [ ] Compact rows still accommodate touch targets, long labels, and text scaling.
- [ ] Hover and click feedback feel quiet, with no stuck pressed or closing states.
- [ ] Input focus does not introduce the rejected border; keyboard orientation is independently checked.
- [ ] Dragging over another component preserves live translucency and does not trap pointer capture.
- [ ] Inspect at 100% zoom and high-DPI scale, at narrow widths, and over contrasting background content.

## 11. Implementation scope and validation limits

The reference is a standalone prototype, not a production component library or a live AI integration. It uses no external fonts, image assets, animation libraries, or WebGL. Embedded textures and CSS provide the material; JavaScript provides theme/colour controls, proximity lighting, modal behavior, and dragging.

During the study, browser checks covered computed material values, theme switching, colour selection, edge-mask tracking, reset behavior, compact dimensions, and model selection. Drag tests used synthetic pointer events with capture mocked; physical pointer capture and touch dragging still require manual verification. Those checks are not a cross-browser visual review or an accessibility audit.

**Extension rule:** add new components by reusing this material, palette, density, and interaction language. Change one material property at a time and compare against the approved baseline. If a change makes the result more glossy, more outlined, more bulky, or more visibly animated, it is probably moving away from the intended design.

## 12. Component library design — per-component material configuration

**Design requirement only; no library implementation or demo changes in this update.** The material controls must be configurable on each component instance by passing values/configuration. They must not depend on global demo sliders or require a settings UI inside every component. An application can expose sliders or preferences and pass the user's choices to the component.

### Configuration surface

The following illustrates the intended contract; names and framework syntax are provisional:

```ts
const material = {
  fineGrain: 18,
  surfaceWear: 8,
  transmission: 54,
  responsiveLight: true,
  lightStrength: { light: 67, dark: 16 },
};

// Illustrative usage, not an existing exported component/API:
// <SeaGlassSearch material={material} />
// <SeaGlassComposer material={{ ...material, fineGrain: 12 }} />
```

| Configuration | Meaning | Example / initial library preset |
| --- | --- | --- |
| `fineGrain` | Fine texture opacity, expressed as a percentage | **18%** |
| `surfaceWear` | Fine surface-wear texture opacity, expressed as a percentage | **8%** |
| `transmission` | Artistic transmission control; base pigment opacity is `1 - value / 100` | **54%** |
| `responsiveLight` | Enable or disable localized pointer-driven edge lighting | `true` |
| `lightStrength` | Response intensity, as one percentage for both themes or separate light/dark percentages | `{ light: 67, dark: 16 }` |

The 18% grain / 8% wear / 54% transmission values above record the latest configuration example and initial library preset. They do **not** silently change the existing demo's 8% / 4% / 54% defaults or the historical baseline documented in section 2. No new light-strength value was supplied in this request, so the existing 67% light / 16% dark values remain the starting preset.

### Resolution and isolation

- Allow partial configuration: omitted values inherit library defaults, or optional application-level defaults if such a mechanism is provided.
- Resolve values in this order: **library preset → application defaults → component-instance overrides**. Merge theme-specific strength values per theme rather than discarding an unspecified theme entry.
- Use percentages (`0–100`) in the public configuration, not a mix of percentages and normalized fractions. Convert to CSS fractions internally. Accept fractional percentages; validate finite values and clamp out-of-range numbers.
- Treat explicit `0` and `false` as valid overrides, not as missing values. Zero grain/wear removes that texture; zero light strength removes the pointer response.
- Apply resolved CSS variables to the component's material scope, not `document.documentElement`. Changing one instance must not recolour, retune, or animate another instance unintentionally.
- Runtime configuration updates should update the existing surface without remounting inputs, resetting user text/selection, losing focus, or reseeding an optional organic contour.
- Accept a scalar `lightStrength` to use the same strength in both themes. Accept a light/dark object when separate values are desired. Theme changes select the appropriate resolved value; they must not overwrite the caller's configuration.
- `responsiveLight: false` disables pointer tracking/response for that surface while retaining static underglow and material texture. A positive strength does not implicitly re-enable it.
- Reduced-motion and coarse/touch-pointer behavior remain safety constraints: requesting responsive light does not override those existing static fallbacks.

### Composition and related overlays

- Search, buttons, composer, list surfaces, draggable cards, and the proposed `SeaGlassPopover` should consume the same material configuration shape.
- A child surface or related popover inherits its owner's resolved material configuration unless explicitly overridden. It can be visually consistent without relying on DOM ancestry.
- Pass resolved configuration explicitly across portal/top-layer boundaries; CSS inheritance alone is not sufficient for an overlay rendered elsewhere in the document.
- Keep configuration of the material independent from content, selection state, behaviour, tint, and optional `edgeStyle`. Organic edges remain off by default regardless of grain or lighting values.
- Configuration values are inputs to the component library. Persistence and user-settings screens belong to the consuming application unless a separate settings facility is explicitly designed later.

### Acceptance criteria for the future library

- Two instances can show different grain, wear, transmission, and lighting simultaneously.
- Partial overrides preserve defaults; `0` and `false` survive resolution.
- A scalar or theme-specific strength behaves correctly through theme changes.
- A portalled model picker receives the owning composer's values and can override them deliberately.
- Live material changes preserve text, focus, selection, and stable organic seeds.
- Turning off responsive light removes its active response without removing static underglow or affecting neighboring components.
