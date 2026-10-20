/**
 * A small, transparent WebGL puppet for the original plush PNG.
 *
 * const renderer = createPlushFaceRenderer(canvas, { onReady, onError });
 * await renderer.load(src, {
 *   imageWidth: 1254, imageHeight: 1254, // Optional landmark coordinate space.
 *   eyes: [{ x, y, rx, ry }, { x, y, rx, ry }],
 *   ears: [{ pivot: [x, y], tip: [x, y], bounds: [left, top, right, bottom] }],
 * }, { signal }); // Optional AbortSignal; cancellation resolves false.
 * renderer.draw({ blink: 0, leftEar: 0, rightEar: 0 });
 * renderer.dispose();
 *
 * Blink ranges from 0 to 1; ear values are radians. This module owns no timer
 * or animation frame. A successful load draws the unchanged image and resolves
 * true. Stale/aborted loads resolve false without invoking onError. Other
 * failures invoke onError(Error) and resolve false, so callers can show <img>.
 */

const GRID_SEGMENTS = 192;
const MAX_EAR_ANGLE = 0.18;

const VERTEX_SHADER = `
precision highp float;
attribute vec2 a_position;
uniform vec2 u_size;
uniform vec4 u_eye0;
uniform vec4 u_eye1;
uniform vec4 u_earBounds0;
uniform vec4 u_earBounds1;
uniform vec4 u_earAxis0;
uniform vec4 u_earAxis1;
uniform vec3 u_pose;
varying VARYING_PRECISION vec2 v_texCoord;

vec2 blinkEye(vec2 p, vec4 eye, float amount) {
  if (eye.z <= 0.0 || eye.w <= 0.0 || amount <= 0.0) return p;
  vec2 delta = p - eye.xy;
  float horizontal = 1.0 - smoothstep(eye.z, eye.z * 2.25, abs(delta.x));
  float vertical = 1.0 - smoothstep(eye.w, eye.w * 3.0, abs(delta.y));
  // d' = d * (1 - strength * taper). The taper decreases with |d|,
  // so its derivative cannot fold the mesh. The core keeps 6% of its height.
  p.y -= delta.y * (0.94 * amount * horizontal * vertical);
  return p;
}

vec2 turnEar(vec2 p, vec4 bounds, vec4 axis, float angle) {
  if (bounds.z <= bounds.x || bounds.w <= bounds.y || abs(angle) < 0.000001) {
    return p;
  }
  vec2 direction = axis.zw - axis.xy;
  float earLength = length(direction);
  if (earLength < 1.0) return p;
  float along = dot(p - axis.xy, direction / earLength);
  float rootStill = clamp(earLength * 0.16, 24.0, 50.0);
  float rootWeight = smoothstep(rootStill, rootStill + earLength * 0.48, along);
  // Pad the rectangle before feathering, so the transparent edge moves with
  // the ear instead of pinning the outermost visible fur to its old location.
  vec2 margin = max(vec2(24.0), (bounds.zw - bounds.xy) * 0.08);
  vec2 leading = smoothstep(bounds.xy - margin, bounds.xy, p);
  vec2 trailing = 1.0 - smoothstep(bounds.zw, bounds.zw + margin, p);
  float weight = leading.x * leading.y * trailing.x * trailing.y * rootWeight;
  float a = angle * weight;
  float s = sin(a);
  float c = cos(a);
  vec2 d = p - axis.xy;
  return axis.xy + vec2(c * d.x - s * d.y, s * d.x + c * d.y);
}

void main() {
  // UVs always refer to the original picture, including all transparent fur.
  v_texCoord = a_position;
  vec2 p = a_position * u_size;
  p = turnEar(p, u_earBounds0, u_earAxis0, u_pose.y);
  p = turnEar(p, u_earBounds1, u_earAxis1, u_pose.z);
  p = blinkEye(p, u_eye0, u_pose.x);
  p = blinkEye(p, u_eye1, u_pose.x);
  vec2 clip = p / u_size * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`;

function fragmentShader(precision) {
  return `
precision ${precision} float;
uniform sampler2D u_image;
varying ${precision} vec2 v_texCoord;
void main() {
  // Upload and canvas both use premultiplied alpha. Do not multiply twice.
  gl_FragColor = texture2D(u_image, v_texCoord);
}
`;
}

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid plush landmark: ${label}.`);
  }
  return value;
}

function pair(value, label) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`Invalid plush landmark: ${label}.`);
  }
  return value.map((coordinate, index) => finite(coordinate, `${label}[${index}]`));
}

function prepareRig(rig = {}, width, height) {
  const sourceWidth = rig.imageWidth ?? width;
  const sourceHeight = rig.imageHeight ?? height;
  if (
    finite(sourceWidth, "imageWidth") <= 0 ||
    finite(sourceHeight, "imageHeight") <= 0
  ) {
    throw new Error("The plush landmark dimensions must be positive.");
  }
  const sx = width / sourceWidth;
  const sy = height / sourceHeight;
  const eyes = (rig.eyes ?? []).slice(0, 2).map((eye, index) => {
    const x = finite(eye.x, `eyes[${index}].x`) * sx;
    const y = finite(eye.y, `eyes[${index}].y`) * sy;
    const rx = finite(eye.rx, `eyes[${index}].rx`) * sx;
    const ry = finite(eye.ry, `eyes[${index}].ry`) * sy;
    if (rx <= 0 || ry <= 0) throw new Error("Plush eye radii must be positive.");
    return [x, y, rx, ry];
  });
  const ears = (rig.ears ?? []).slice(0, 2).map((ear, index) => {
    if (!Array.isArray(ear.bounds) || ear.bounds.length !== 4) {
      throw new Error(`Invalid plush landmark: ears[${index}].bounds.`);
    }
    const bounds = ear.bounds.map((value, i) =>
      finite(value, `ears[${index}].bounds[${i}]`) * (i % 2 ? sy : sx),
    );
    if (bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) {
      throw new Error("Plush ear bounds must describe a positive rectangle.");
    }
    const pivot = pair(ear.pivot, `ears[${index}].pivot`).map((v, i) => v * (i ? sy : sx));
    const tip = ear.tip
      ? pair(ear.tip, `ears[${index}].tip`).map((v, i) => v * (i ? sy : sx))
      : [(bounds[0] + bounds[2]) / 2, bounds[1]];
    return { bounds, axis: [...pivot, ...tip] };
  });
  return { eyes, ears };
}

function createMesh(width, height, rig) {
  const xs = new Set();
  const ys = new Set();
  for (let i = 0; i <= GRID_SEGMENTS; i += 1) {
    xs.add(i / GRID_SEGMENTS);
    ys.add(i / GRID_SEGMENTS);
  }
  // Put rows through the eyes as well as around their edges. Small eyes must
  // still close cleanly when they happen to fall between regular grid rows.
  for (const [x, y, rx, ry] of rig.eyes) {
    for (const multiplier of [-3, -2.25, -1, -0.5, 0, 0.5, 1, 2.25, 3]) {
      xs.add(Math.max(0, Math.min(1, (x + rx * multiplier) / width)));
      ys.add(Math.max(0, Math.min(1, (y + ry * multiplier) / height)));
    }
  }
  const columns = [...xs].sort((a, b) => a - b);
  const rows = [...ys].sort((a, b) => a - b);
  const positions = new Float32Array(columns.length * rows.length * 2);
  let vertex = 0;
  for (const y of rows) {
    for (const x of columns) {
      positions[vertex++] = x;
      positions[vertex++] = y;
    }
  }
  const indices = new Uint16Array((columns.length - 1) * (rows.length - 1) * 6);
  let cursor = 0;
  for (let row = 0; row < rows.length - 1; row += 1) {
    for (let column = 0; column < columns.length - 1; column += 1) {
      const topLeft = row * columns.length + column;
      const bottomLeft = topLeft + columns.length;
      indices[cursor++] = topLeft;
      indices[cursor++] = bottomLeft;
      indices[cursor++] = topLeft + 1;
      indices[cursor++] = topLeft + 1;
      indices[cursor++] = bottomLeft;
      indices[cursor++] = bottomLeft + 1;
    }
  }
  return { positions, indices };
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Could not allocate the plush animation shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Could not compile the plush animation shader: ${log || "unknown error"}`);
  }
  return shader;
}

function bounded(value, minimum, maximum) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : 0;
}

export function createPlushFaceRenderer(canvas, { onReady, onError } = {}) {
  if (!canvas?.getContext || !canvas?.addEventListener) {
    try {
      onError?.(new Error("A canvas is required for plush animation."));
    } catch {
      // Preserve the static-picture fallback even if its callback fails.
    }
    return { load: () => Promise.resolve(false), draw: () => false, dispose() {} };
  }
  let gl = null;
  let resources = null;
  let disposed = false;
  let contextLost = false;
  let ready = false;
  let generation = 0;
  let cancelPending = null;
  let desiredLoad = null;
  let currentRig = null;
  let dimensions = [1, 1];
  let lastPose = { blink: 0, leftEar: 0, rightEar: 0 };
  let resizeObserver = null;

  function report(error) {
    if (!disposed && typeof onError === "function") {
      try {
        onError(error instanceof Error ? error : new Error(String(error)));
      } catch {
        // Consumer callbacks cannot turn a recoverable fallback into a rejection.
      }
    }
  }

  function resize() {
    if (disposed || dimensions[0] <= 1) return false;
    const cssWidth = canvas.clientWidth || dimensions[0];
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const scale = Math.min(
      1,
      768 / Math.max(...dimensions),
      Math.max(256, Math.ceil(cssWidth * dpr)) / dimensions[0],
    );
    const width = Math.max(1, Math.round(dimensions[0] * scale));
    const height = Math.max(1, Math.round(dimensions[1] * scale));
    if (canvas.width === width && canvas.height === height) return false;
    canvas.width = width;
    canvas.height = height;
    return true;
  }

  function releaseResources() {
    if (!resources || !gl) return;
    gl.deleteTexture(resources.texture);
    gl.deleteBuffer(resources.vertices);
    gl.deleteBuffer(resources.indices);
    gl.deleteProgram(resources.program);
    resources = null;
  }

  function initialize() {
    if (disposed || contextLost) return false;
    try {
      gl = canvas.getContext("webgl", {
        alpha: true,
        antialias: true,
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        powerPreference: "low-power",
      });
      if (!gl || gl.isContextLost()) throw new Error("Plush animation is unavailable in this browser.");
      const highPrecision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
      const texturePrecision = highPrecision?.precision ? "highp" : "mediump";
      const vertexShader = compileShader(
        gl,
        gl.VERTEX_SHADER,
        VERTEX_SHADER.replace("VARYING_PRECISION", texturePrecision),
      );
      let pixelShader = null;
      let program = null;
      try {
        pixelShader = compileShader(
          gl,
          gl.FRAGMENT_SHADER,
          fragmentShader(texturePrecision),
        );
        program = gl.createProgram();
        if (!program) throw new Error("Could not allocate the plush animation program.");
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, pixelShader);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          throw new Error(`Could not link the plush animation: ${gl.getProgramInfoLog(program) || "unknown error"}`);
        }
      } catch (error) {
        if (program) gl.deleteProgram(program);
        throw error;
      } finally {
        gl.deleteShader(vertexShader);
        if (pixelShader) gl.deleteShader(pixelShader);
      }
      resources = {
        program,
        vertices: gl.createBuffer(),
        indices: gl.createBuffer(),
        texture: gl.createTexture(),
        position: gl.getAttribLocation(program, "a_position"),
        uniforms: {},
        count: 0,
      };
      if (!resources.vertices || !resources.indices || !resources.texture) {
        throw new Error("Could not allocate the plush animation buffers.");
      }
      for (const name of [
        "u_size", "u_eye0", "u_eye1", "u_earBounds0", "u_earBounds1",
        "u_earAxis0", "u_earAxis1", "u_pose", "u_image",
      ]) {
        resources.uniforms[name] = gl.getUniformLocation(program, name);
      }
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      return true;
    } catch (error) {
      releaseResources();
      report(error);
      return false;
    }
  }

  function draw({ blink = 0, leftEar = 0, rightEar = 0 } = {}) {
    if (disposed || contextLost || !ready || !resources || !gl) return false;
    if (gl.isContextLost()) return false;
    lastPose = { blink, leftEar, rightEar };
    const { program, uniforms, position, vertices, indices, texture, count } = resources;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(uniforms.u_image, 0);
    gl.uniform2fv(uniforms.u_size, dimensions);
    gl.uniform3f(
      uniforms.u_pose,
      bounded(blink, 0, 1),
      bounded(leftEar, -MAX_EAR_ANGLE, MAX_EAR_ANGLE),
      bounded(rightEar, -MAX_EAR_ANGLE, MAX_EAR_ANGLE),
    );
    const zero = [0, 0, 0, 0];
    for (let i = 0; i < 2; i += 1) {
      gl.uniform4fv(uniforms[`u_eye${i}`], currentRig.eyes[i] ?? zero);
      gl.uniform4fv(uniforms[`u_earBounds${i}`], currentRig.ears[i]?.bounds ?? zero);
      gl.uniform4fv(uniforms[`u_earAxis${i}`], currentRig.ears[i]?.axis ?? zero);
    }
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
    return true;
  }

  function startLoad(src, rig = {}, { signal } = {}) {
    cancelPending?.();
    const request = ++generation;
    ready = false;
    desiredLoad = { src, rig };
    if (disposed || contextLost || signal?.aborted) return Promise.resolve(false);
    if (!resources && !initialize()) return Promise.resolve(false);

    return new Promise((resolve) => {
      const image = new Image();
      let settled = false;
      function finish(success) {
        if (settled) return;
        settled = true;
        image.onload = null;
        image.onerror = null;
        signal?.removeEventListener("abort", abort);
        if (cancelPending === abort) cancelPending = null;
        resolve(success);
      }
      function abort() {
        if (settled) return;
        finish(false);
        image.removeAttribute("src");
      }
      cancelPending = abort;
      signal?.addEventListener("abort", abort, { once: true });
      image.crossOrigin = "anonymous";
      image.decoding = "async";
      image.onload = () => {
        if (disposed || contextLost || request !== generation || signal?.aborted) {
          finish(false);
          return;
        }
        try {
          const width = image.naturalWidth;
          const height = image.naturalHeight;
          if (!width || !height) throw new Error("The plush picture is empty.");
          if (width > gl.getParameter(gl.MAX_TEXTURE_SIZE) || height > gl.getParameter(gl.MAX_TEXTURE_SIZE)) {
            throw new Error("The plush picture exceeds this browser's texture size.");
          }
          currentRig = prepareRig(rig, width, height);
          const mesh = createMesh(width, height, currentRig);
          dimensions = [width, height];
          resize();
          gl.bindBuffer(gl.ARRAY_BUFFER, resources.vertices);
          gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, resources.indices);
          gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
          resources.count = mesh.indices.length;
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, resources.texture);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
          if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) {
            throw new Error("Could not upload the plush picture for animation.");
          }
          ready = true;
          draw();
          finish(true);
          if (!disposed && typeof onReady === "function") {
            try {
              onReady({ width, height });
            } catch {
              // Readiness callbacks belong to the caller, not image decoding.
            }
          }
        } catch (error) {
          ready = false;
          finish(false);
          report(error);
        }
      };
      image.onerror = () => {
        if (disposed || request !== generation || signal?.aborted) {
          finish(false);
          return;
        }
        finish(false);
        report(new Error("Could not load the plush picture for animation."));
      };
      image.src = src;
    });
  }

  function load(src, rig = {}, options = {}) {
    try {
      if (typeof src !== "string" || !src.trim()) {
        throw new Error("A plush picture URL is required.");
      }
      return startLoad(src, rig, options).catch((error) => {
        ready = false;
        report(error);
        return false;
      });
    } catch (error) {
      ready = false;
      cancelPending?.();
      generation += 1;
      report(error);
      return Promise.resolve(false);
    }
  }

  function handleContextLost(event) {
    event.preventDefault();
    contextLost = true;
    ready = false;
    generation += 1;
    cancelPending?.();
    // Lost context resources have already been released by the browser.
    resources = null;
    report(new Error("The plush animation context was interrupted."));
  }

  function handleContextRestored() {
    if (disposed) return;
    contextLost = false;
    if (initialize() && desiredLoad) load(desiredLoad.src, desiredLoad.rig);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    ready = false;
    generation += 1;
    cancelPending?.();
    desiredLoad = null;
    currentRig = null;
    resizeObserver?.disconnect();
    canvas.removeEventListener("webglcontextlost", handleContextLost);
    canvas.removeEventListener("webglcontextrestored", handleContextRestored);
    releaseResources();
    gl = null;
  }

  canvas.addEventListener("webglcontextlost", handleContextLost);
  canvas.addEventListener("webglcontextrestored", handleContextRestored);
  if (typeof ResizeObserver !== "undefined") {
    try {
      resizeObserver = new ResizeObserver(() => {
        if (resize() && ready) draw(lastPose);
      });
      resizeObserver.observe(canvas);
    } catch {
      resizeObserver?.disconnect();
      resizeObserver = null;
    }
  }
  return { load, draw, dispose };
}
