import { makeFullScreenQuad, makePipeline } from "./utils.js";

import makeRain from "./rainPass.js";
import makeBloomPass from "./bloomPass.js";
import makePalettePass from "./palettePass.js";
// Graviton exposes only the offline palette presets: no camera, remote images or devices.

const dimensions = { width: 1, height: 1 };

const loadJS = (src) =>
	new Promise((resolve, reject) => {
		const tag = document.createElement("script");
		tag.onload = resolve;
		tag.onerror = reject;
		tag.src = src;
		document.body.appendChild(tag);
	});

export default async (canvas, config) => {
	await Promise.all([loadJS("lib/regl.min.js"), loadJS("lib/gl-matrix.js")]);

	const resize = () => {
		const devicePixelRatio = Math.min(window.devicePixelRatio ?? 1, 2);
		canvas.width = Math.ceil(canvas.clientWidth * devicePixelRatio * config.resolution);
		canvas.height = Math.ceil(canvas.clientHeight * devicePixelRatio * config.resolution);
	};
	window.onresize = resize;
	resize();

	const extensions = ["OES_texture_half_float", "OES_texture_half_float_linear"];
	// These extensions are also needed, but Safari misreports that they are missing
	const optionalExtensions = ["EXT_color_buffer_half_float", "WEBGL_color_buffer_float", "OES_standard_derivatives"];

	switch (config.testFix) {
		case "fwidth_10_1_2022_A":
			extensions.push("OES_standard_derivatives");
			break;
		case "fwidth_10_1_2022_B":
			optionalExtensions.forEach((ext) => extensions.push(ext));
			extensions.length = 0;
			break;
	}

	const regl = createREGL({ canvas, pixelRatio: 1, extensions, optionalExtensions });

	const lkg = { enabled: false, tileX: 1, tileY: 1 };

	// All this takes place in a full screen quad.
	const fullScreenQuad = makeFullScreenQuad(regl);
	const context = { regl, config, lkg };
	const pipeline = makePipeline(context, [makeRain, makeBloomPass, makePalettePass]);
	const screenUniforms = { tex: pipeline[pipeline.length - 1].outputs.primary };
	const drawToScreen = regl({ uniforms: screenUniforms });
	try {
		await Promise.all(pipeline.map((step) => step.ready));
	} catch (error) {
		regl.destroy();
		throw error;
	}

	const targetFrameTimeMilliseconds = 1000 / config.fps;
	let last = NaN;

	const renderFrame = ({ viewportWidth, viewportHeight }) => {
		const now = regl.now() * 1000;

		if (isNaN(last)) {
			last = now - targetFrameTimeMilliseconds;
		}

		const shouldRender = now - last >= targetFrameTimeMilliseconds;

		if (!shouldRender) return;

		if (shouldRender) {
			while (now - targetFrameTimeMilliseconds > last) {
				last += targetFrameTimeMilliseconds;
			}
		}

		if (dimensions.width !== viewportWidth || dimensions.height !== viewportHeight) {
			dimensions.width = viewportWidth;
			dimensions.height = viewportHeight;
			for (const step of pipeline) {
				step.setSize(viewportWidth, viewportHeight);
			}
		}
		fullScreenQuad(() => {
			for (const step of pipeline) {
				step.execute(shouldRender);
			}
			drawToScreen();
		});
	};

	// Draw one static frame for reduced motion before allocating any RAF callbacks.
	regl.poll();
	renderFrame({ viewportWidth: canvas.width, viewportHeight: canvas.height });

	// Graviton owns visibility/reduced-motion lifecycle; cancel RAF entirely while paused.
	let tick = null;
	return {
		setPaused(paused) {
			if (paused) {
				tick?.cancel();
				tick = null;
			} else if (!tick) {
				last = NaN;
				tick = regl.frame(renderFrame);
			}
		},
		destroy() {
			tick?.cancel();
			window.onresize = null;
			regl.destroy();
		},
	};
};
