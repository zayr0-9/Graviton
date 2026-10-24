# Matrix wallpaper

Vendored from https://github.com/Rezmason/matrix at commit
5ba90490453ceceb6812d6b1bc658a99a92411d0. Copyright 2018 Rezmason, MIT (see LICENSE).

Only the WebGL runtime, its local libraries/shaders and original Matrix Code / Matrix
Resurrected atlases are bundled. Third-party derived Coptic, Gothic and Huberfish
fonts, camera/mirror media and WebGPU are not offered by Graviton.

gl-matrix retains its MIT copyright/license header in lib/. REGL's MIT notice
is included separately in lib/REGL-LICENSE.txt.
Graviton's wallpaper.html and wallpaper.js provide lifecycle/isolation integration.
See js/regl/main.js for lifecycle/error handling, frame caps, static reduced-motion
rendering and removal of unused camera/image/device integrations. Other upstream
runtime sources are unmodified except utils.js, which checks shader HTTP errors. No network service is required at runtime.

Upstream describes the classic and Resurrections glyphs as its free fonts and
encourages project redistribution under MIT. These original atlases are distributed
under the repository license; no third-party-derived glyph atlases are included.
https://github.com/Rezmason/matrix#typography
