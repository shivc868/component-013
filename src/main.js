import "./style.css";
import * as THREE from "three";
import GUI from "lil-gui";
import gsap from "gsap";

/* Iridescent "folded silk" sculpture with a live editor. Every knob
   lives in PARAMS; the lil-gui panel edits it in place and the Copy
   configuration button exports the lot as JSON. To bake a look you
   like, paste the copied JSON over the PARAMS values below. */

/* the user's approved final look (exported from the editor 2026-08-07) */
const PARAMS = {
  // shape — fold geometry, all fed to the vertex shader as uniforms
  lobeFrequency: 1.01, // how many big lobes wrap the sphere
  lobeDepth: 0.31, // how far the lobes push in and out
  ridgeFrequency: 1.36, // density of the fold creases
  ridgeDepth: 0.25, // how tall the creases stand
  edgeSharpness: 0.89, // 0.4 = pillowy melt, 3 = crisp ribbon edges
  shrink: 0.17, // pulls the whole surface inward, keeps it in frame

  // motion
  morphSpeed: 0.036, // how fast the folds melt and reform
  spinSpeed: 0.3, // idle rotation, radians/s

  // mouse interaction
  mouseFollow: 0.22, // tilt toward the pointer
  mouseEase: 0.04, // how lazily everything follows the pointer
  mouseParallax: 0.23, // the sculpture drifts toward the pointer
  mouseBulge: 0.24, // the surface swells on the pointer's side
  mouseBulgeSize: 0.2, // how wide that swell spreads
  bgMouseFollow: 0.4, // background glows lean toward the pointer

  // material
  baseColor: "#9a7bff", // tints every reflection
  metalness: 0.7,
  roughness: 0.06,
  iridescence: 0.33, // oil-slick hue shift; 1.0 washes toward white
  iridescenceIOR: 1.56,
  clearcoat: 0.16, // lacquer layer, the glassy top sheen
  clearcoatRoughness: 0.93,
  envIntensity: 1.16,
  exposure: 2.5,

  // studio — the coloured softboxes the chrome reflects; on a
  // full-metal surface this IS the paint job
  keyColor: "#ff0000", // big panel, up-left
  fillColor: "#a30078", // panel, right
  backdropColor: "#2af8f5", // large panel behind
  stripAColor: "#ff7a1a", // thin strip, low front
  stripBColor: "#ffb545", // thin strip, back-left
  sparkColor: "#141cff", // small slash for hot highlights
  ambienceColor: "#010f13", // studio background wash

  // view
  scale: 0.71,

  // background — the animated WebGL colour wash behind the page
  bgBase: "#010f13", // floor colour the glows sit on
  bgColor1: "#a30078", // magenta glow, upper left
  bgColor2: "#ff2d43", // red glow, upper right
  bgColor3: "#14a5ff", // blue glow, lower right
  bgColor4: "#ffb545", // amber glow, lower left
  bgSpeed: 0.6, // how fast the wash drifts
  bgScale: 3, // zoom of the warp noise
  bgWarp: 1.5, // how much the noise smears the glows around
  bgBrightness: 0.65, // overall glow strength
  bgSpotSize: 0.87, // glow radius; big = soft blurred wash
  bgVignette: 0.35, // darkened corners
  bgGrain: 0.25, // film grain over the wash
};

const stage = document.querySelector(".mfa-hero");
const canvas = document.querySelector(".mfa-hero__canvas");

const reduceMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;

/* WebGL can be unavailable (graphics acceleration disabled, blocklisted
   GPU, remote desktop). Fail with a visible explanation instead of a
   silent black stage and an uncaught error. */
let renderer;
try {
  /* alpha: the sculpture floats over the page's glow background */
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
} catch (err) {
  canvas.insertAdjacentHTML(
    "afterend",
    `<p class="mfa-hero__fallback">
      This 3D scene needs WebGL, which your browser has disabled.<br />
      Enable "Use graphics acceleration" in the browser settings and relaunch.
    </p>`,
  );
  throw err;
}
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = PARAMS.exposure;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 20);
camera.position.set(0, 0, 5);

/* ----- studio environment ----- */

const pmrem = new THREE.PMREMGenerator(renderer);
let envTexture = null;

function rebuildStudio() {
  const studio = new THREE.Scene();
  studio.background = new THREE.Color(PARAMS.ambienceColor);
  const box = (color, w, h, pos) => {
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
    );
    panel.position.set(...pos);
    panel.lookAt(0, 0, 0);
    studio.add(panel);
  };
  box(PARAMS.keyColor, 7, 7, [-4, 4, 3]);
  box(PARAMS.fillColor, 5, 6, [5, 1, 2]);
  box(PARAMS.backdropColor, 8, 8, [0, -1, -6]);
  box(PARAMS.stripAColor, 9, 1.1, [0, -4.5, 1]);
  box(PARAMS.stripBColor, 1.2, 7, [-5.5, -1, -2]);
  box(PARAMS.sparkColor, 2.2, 0.8, [2.5, 5, 1]);

  const old = envTexture;
  envTexture = pmrem.fromScene(studio, 0.05).texture;
  scene.environment = envTexture;
  if (old) old.dispose();
}
rebuildStudio();

/* ----- material + deforming shader ----- */

const uniforms = {
  uTime: { value: 0 },
  uLobeFreq: { value: PARAMS.lobeFrequency },
  uLobeAmp: { value: PARAMS.lobeDepth },
  uRidgeFreq: { value: PARAMS.ridgeFrequency },
  uRidgeAmp: { value: PARAMS.ridgeDepth },
  uEdgeSharp: { value: PARAMS.edgeSharpness },
  uShrink: { value: PARAMS.shrink },
  /* pointer direction in the mesh's object space; the surface swells
     toward it (mouseBulge) */
  uPointerDir: { value: new THREE.Vector3(0, 0, 1) },
  uBulge: { value: PARAMS.mouseBulge },
  uBulgeSize: { value: PARAMS.mouseBulgeSize },
};

const material = new THREE.MeshPhysicalMaterial({
  color: PARAMS.baseColor,
  metalness: PARAMS.metalness,
  roughness: PARAMS.roughness,
  iridescence: PARAMS.iridescence,
  iridescenceIOR: PARAMS.iridescenceIOR,
  envMapIntensity: PARAMS.envIntensity,
  clearcoat: PARAMS.clearcoat,
  clearcoatRoughness: PARAMS.clearcoatRoughness,
});

/* GLSL: Ashima 3D simplex noise + the deformation. The displaced
   normal is rebuilt by finite differences on the unit sphere, because
   the noise moves every vertex and the stored normals are meaningless. */
const noiseGLSL = /* glsl */ `
uniform float uTime;
uniform float uLobeFreq;
uniform float uLobeAmp;
uniform float uRidgeFreq;
uniform float uRidgeAmp;
uniform float uEdgeSharp;
uniform float uShrink;
uniform vec3 uPointerDir;
uniform float uBulge;
uniform float uBulgeSize;

vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

float fbm(vec3 p){
  float sum = 0.0;
  float amp = 0.6;
  for(int i = 0; i < 2; i++){
    sum += amp * snoise(p);
    p = p * 1.9 + 17.1;
    amp *= 0.45;
  }
  return sum;
}

/* radial displacement: big lobes + creases whose sharpness is the
   uEdgeSharp knob (low = pillowy melt, high = crisp ribbon edges) */
vec3 deform(vec3 p){
  vec3 n = normalize(p);
  float t = uTime;
  float lobes = fbm(n * uLobeFreq + t);
  float ridge = 1.0 - abs(snoise(n * uRidgeFreq - t * 0.5));
  ridge = ridge * ridge * (3.0 - 2.0 * ridge);
  ridge = pow(ridge, uEdgeSharp);
  float d = uLobeAmp * lobes + uRidgeAmp * ridge - uShrink;
  /* swell toward the pointer: gaussian falloff around its direction */
  float toward = dot(n, uPointerDir);
  d += uBulge * exp(-(1.0 - toward) / max(uBulgeSize * uBulgeSize * 0.5, 1e-4));
  return n * (1.0 + d);
}

vec3 blobNormal(vec3 p){
  vec3 n = normalize(p);
  vec3 t = normalize(
    abs(n.y) < 0.99 ? cross(n, vec3(0.0, 1.0, 0.0)) : cross(n, vec3(1.0, 0.0, 0.0))
  );
  vec3 b = cross(n, t);
  float e = 0.02; /* wider sampling = softer shading over the folds */
  vec3 p0 = deform(n);
  vec3 pt = deform(normalize(n + t * e));
  vec3 pb = deform(normalize(n + b * e));
  return normalize(cross(pb - p0, pt - p0));
}
`;

material.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = noiseGLSL + shader.vertexShader;
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <beginnormal_vertex>",
      "vec3 objectNormal = blobNormal(position);",
    )
    .replace("#include <begin_vertex>", "vec3 transformed = deform(position);");
};

/* detail 96 = ~184k triangles: plenty for the low-frequency folds and
   comfortably 60fps territory on mid-range GPUs */
const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 96), material);
scene.add(mesh);

/* ----- animated background -----
   A second, cheap WebGL context: one full-screen quad whose fragment
   shader drifts four coloured glow spots around and smears them with
   simplex noise — the "blurred studio wash" the reference page has,
   but alive. Sits at z-index 0, under the title and the sculpture. */

const bgCanvas = document.querySelector(".mfa-hero__bg");
const bgRenderer = new THREE.WebGLRenderer({ canvas: bgCanvas });
const bgScene = new THREE.Scene();
const bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const bgUniforms = {
  uTime: { value: 0 },
  uRes: { value: new THREE.Vector2(1, 1) },
  uBase: { value: new THREE.Color(PARAMS.bgBase) },
  uC1: { value: new THREE.Color(PARAMS.bgColor1) },
  uC2: { value: new THREE.Color(PARAMS.bgColor2) },
  uC3: { value: new THREE.Color(PARAMS.bgColor3) },
  uC4: { value: new THREE.Color(PARAMS.bgColor4) },
  uSpeed: { value: PARAMS.bgSpeed },
  uScale: { value: PARAMS.bgScale },
  uWarp: { value: PARAMS.bgWarp },
  uBrightness: { value: PARAMS.bgBrightness },
  uSpotSize: { value: PARAMS.bgSpotSize },
  uVignette: { value: PARAMS.bgVignette },
  uGrain: { value: PARAMS.bgGrain },
  uMouse: { value: new THREE.Vector2(0, 0) },
  uMouseAmt: { value: PARAMS.bgMouseFollow },
};

const bgMaterial = new THREE.ShaderMaterial({
  uniforms: bgUniforms,
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){
      vUv = position.xy * 0.5 + 0.5;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform vec2 uRes;
    uniform float uTime;
    uniform vec3 uBase, uC1, uC2, uC3, uC4;
    uniform float uSpeed, uScale, uWarp, uBrightness, uSpotSize, uVignette, uGrain;
    uniform vec2 uMouse;
    uniform float uMouseAmt;

    ${/* same Ashima simplex noise, trimmed to what the wash needs */ ""}
    vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
    vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
    vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
    vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
    float snoise(vec3 v){
      const vec2 C = vec2(1.0/6.0, 1.0/3.0);
      const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
      vec3 i  = floor(v + dot(v, C.yyy));
      vec3 x0 = v - i + dot(i, C.xxx);
      vec3 g = step(x0.yzx, x0.xyz);
      vec3 l = 1.0 - g;
      vec3 i1 = min(g.xyz, l.zxy);
      vec3 i2 = max(g.xyz, l.zxy);
      vec3 x1 = x0 - i1 + C.xxx;
      vec3 x2 = x0 - i2 + C.yyy;
      vec3 x3 = x0 - D.yyy;
      i = mod289(i);
      vec4 p = permute(permute(permute(
          i.z + vec4(0.0, i1.z, i2.z, 1.0))
        + i.y + vec4(0.0, i1.y, i2.y, 1.0))
        + i.x + vec4(0.0, i1.x, i2.x, 1.0));
      float n_ = 0.142857142857;
      vec3 ns = n_ * D.wyz - D.xzx;
      vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
      vec4 x_ = floor(j * ns.z);
      vec4 y_ = floor(j - 7.0 * x_);
      vec4 x = x_ * ns.x + ns.yyyy;
      vec4 y = y_ * ns.x + ns.yyyy;
      vec4 h = 1.0 - abs(x) - abs(y);
      vec4 b0 = vec4(x.xy, y.xy);
      vec4 b1 = vec4(x.zw, y.zw);
      vec4 s0 = floor(b0) * 2.0 + 1.0;
      vec4 s1 = floor(b1) * 2.0 + 1.0;
      vec4 sh = -step(h, vec4(0.0));
      vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
      vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
      vec3 p0 = vec3(a0.xy, h.x);
      vec3 p1 = vec3(a0.zw, h.y);
      vec3 p2 = vec3(a1.xy, h.z);
      vec3 p3 = vec3(a1.zw, h.w);
      vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
      p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
      vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
      m = m * m;
      return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
    }

    float glow(vec2 p, vec2 c, float r){
      float d = length(p - c);
      return exp(-(d * d) / (r * r));
    }

    void main(){
      float aspect = uRes.x / uRes.y;
      /* x spans ±aspect, y spans ±1 */
      vec2 p = (vUv - 0.5) * 2.0 * vec2(aspect, 1.0);
      float t = uTime * uSpeed;

      /* noise smear so the glows never look like static gradients */
      vec2 q = p + uWarp * vec2(
        snoise(vec3(p * 0.55 * uScale, t * 0.7)),
        snoise(vec3(p * 0.55 * uScale + 13.7, t * 0.7))
      );
      /* the whole wash leans toward the pointer */
      q -= uMouse * uMouseAmt;

      /* four glows orbiting their home corners */
      vec3 col = uBase;
      col += uC1 * uBrightness * 0.60 *
        glow(q, vec2(-0.62 * aspect + 0.2 * sin(t * 0.9), 0.45 + 0.15 * cos(t * 0.7)), uSpotSize);
      col += uC2 * uBrightness * 0.34 *
        glow(q, vec2(0.7 * aspect + 0.18 * cos(t * 0.8), 0.55 + 0.14 * sin(t)), uSpotSize * 0.85);
      col += uC3 * uBrightness * 0.26 *
        glow(q, vec2(0.6 * aspect + 0.2 * sin(t * 0.6), -0.62 + 0.16 * cos(t * 0.9)), uSpotSize * 0.9);
      col += uC4 * uBrightness * 0.18 *
        glow(q, vec2(-0.66 * aspect + 0.16 * cos(t), -0.6 + 0.18 * sin(t * 0.8)), uSpotSize * 0.75);
      /* faint magenta heart so the centre never goes dead black */
      col += uC1 * uBrightness * 0.22 * glow(q, vec2(0.0, -0.05), uSpotSize * 1.35);

      /* corner fade */
      vec2 v = vUv - 0.5;
      col *= 1.0 - uVignette * smoothstep(0.15, 0.75, dot(v, v) * 2.0);

      /* animated grain hides gradient banding */
      float g = fract(sin(dot(gl_FragCoord.xy + mod(uTime, 100.0) * 60.0, vec2(12.9898, 78.233))) * 43758.5453);
      col += (g - 0.5) * uGrain;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
bgScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMaterial));

/* ----- editor panel -----
   dev tool, hidden on the finished page: add #editor to the URL
   (e.g. localhost:5176/#editor) to tune PARAMS live and copy the
   configuration. Listens for the hash appearing at any time, so typing
   it into an already-open tab works without a reload. */

let editorStarted = false;

function initEditor() {
  if (editorStarted) return;
  editorStarted = true;

  const CONFIG_KEYS = Object.keys(PARAMS);

  const actions = {
    copyConfiguration() {
      const config = {};
      CONFIG_KEYS.forEach((k) => (config[k] = PARAMS[k]));
      const json = JSON.stringify(config, null, 2);
      navigator.clipboard
        .writeText(json)
        .then(() => console.log("Blob config copied to clipboard:\n" + json))
        .catch(() => {
          /* clipboard can be blocked outside secure contexts; still make
             the config easy to grab */
          console.log("Copy this configuration:\n" + json);
          window.prompt("Copy the configuration below:", json);
        });
    },
  };

  const gui = new GUI({ title: "Blob editor" });

  const shapeFolder = gui.addFolder("Shape");
  shapeFolder
    .add(PARAMS, "lobeFrequency", 0.2, 2.5, 0.01)
    .onChange((v) => (uniforms.uLobeFreq.value = v));
  shapeFolder
    .add(PARAMS, "lobeDepth", 0, 1, 0.01)
    .onChange((v) => (uniforms.uLobeAmp.value = v));
  shapeFolder
    .add(PARAMS, "ridgeFrequency", 0.3, 4, 0.01)
    .onChange((v) => (uniforms.uRidgeFreq.value = v));
  shapeFolder
    .add(PARAMS, "ridgeDepth", 0, 1, 0.01)
    .onChange((v) => (uniforms.uRidgeAmp.value = v));
  shapeFolder
    .add(PARAMS, "edgeSharpness", 0.3, 4, 0.01)
    .onChange((v) => (uniforms.uEdgeSharp.value = v));
  shapeFolder
    .add(PARAMS, "shrink", 0, 0.6, 0.01)
    .onChange((v) => (uniforms.uShrink.value = v));
  shapeFolder.add(PARAMS, "scale", 0.4, 1.6, 0.01);

  const motionFolder = gui.addFolder("Motion");
  motionFolder.add(PARAMS, "morphSpeed", 0, 0.3, 0.001);
  motionFolder.add(PARAMS, "spinSpeed", 0, 0.3, 0.001);

  const mouseFolder = gui.addFolder("Mouse");
  mouseFolder.add(PARAMS, "mouseFollow", 0, 1.5, 0.01);
  mouseFolder.add(PARAMS, "mouseEase", 0.01, 0.3, 0.005);
  mouseFolder.add(PARAMS, "mouseParallax", 0, 1, 0.01);
  mouseFolder
    .add(PARAMS, "mouseBulge", 0, 0.6, 0.01)
    .onChange((v) => (uniforms.uBulge.value = v));
  mouseFolder
    .add(PARAMS, "mouseBulgeSize", 0.2, 1.5, 0.01)
    .onChange((v) => (uniforms.uBulgeSize.value = v));
  mouseFolder
    .add(PARAMS, "bgMouseFollow", 0, 1, 0.01)
    .onChange((v) => (bgUniforms.uMouseAmt.value = v));

  const materialFolder = gui.addFolder("Material");
  materialFolder
    .addColor(PARAMS, "baseColor")
    .onChange((v) => material.color.set(v));
  materialFolder
    .add(PARAMS, "metalness", 0, 1, 0.01)
    .onChange((v) => (material.metalness = v));
  materialFolder
    .add(PARAMS, "roughness", 0, 1, 0.01)
    .onChange((v) => (material.roughness = v));
  materialFolder
    .add(PARAMS, "iridescence", 0, 1, 0.01)
    .onChange((v) => (material.iridescence = v));
  materialFolder
    .add(PARAMS, "iridescenceIOR", 1, 2.4, 0.01)
    .onChange((v) => (material.iridescenceIOR = v));
  materialFolder
    .add(PARAMS, "clearcoat", 0, 1, 0.01)
    .onChange((v) => (material.clearcoat = v));
  materialFolder
    .add(PARAMS, "clearcoatRoughness", 0, 1, 0.01)
    .onChange((v) => (material.clearcoatRoughness = v));
  materialFolder
    .add(PARAMS, "envIntensity", 0, 3, 0.01)
    .onChange((v) => (material.envMapIntensity = v));
  materialFolder
    .add(PARAMS, "exposure", 0.2, 2.5, 0.01)
    .onChange((v) => (renderer.toneMappingExposure = v));

  const studioFolder = gui.addFolder("Reflection colors");
  [
    "keyColor",
    "fillColor",
    "backdropColor",
    "stripAColor",
    "stripBColor",
    "sparkColor",
    "ambienceColor",
  ].forEach((key) =>
    studioFolder.addColor(PARAMS, key).onChange(rebuildStudio),
  );

  const bgFolder = gui.addFolder("Background");
  bgFolder
    .addColor(PARAMS, "bgBase")
    .onChange((v) => bgUniforms.uBase.value.set(v));
  bgFolder
    .addColor(PARAMS, "bgColor1")
    .onChange((v) => bgUniforms.uC1.value.set(v));
  bgFolder
    .addColor(PARAMS, "bgColor2")
    .onChange((v) => bgUniforms.uC2.value.set(v));
  bgFolder
    .addColor(PARAMS, "bgColor3")
    .onChange((v) => bgUniforms.uC3.value.set(v));
  bgFolder
    .addColor(PARAMS, "bgColor4")
    .onChange((v) => bgUniforms.uC4.value.set(v));
  bgFolder
    .add(PARAMS, "bgSpeed", 0, 0.6, 0.005)
    .onChange((v) => (bgUniforms.uSpeed.value = v));
  bgFolder
    .add(PARAMS, "bgScale", 0.4, 3, 0.01)
    .onChange((v) => (bgUniforms.uScale.value = v));
  bgFolder
    .add(PARAMS, "bgWarp", 0, 1.5, 0.01)
    .onChange((v) => (bgUniforms.uWarp.value = v));
  bgFolder
    .add(PARAMS, "bgBrightness", 0, 2, 0.01)
    .onChange((v) => (bgUniforms.uBrightness.value = v));
  bgFolder
    .add(PARAMS, "bgSpotSize", 0.2, 2, 0.01)
    .onChange((v) => (bgUniforms.uSpotSize.value = v));
  bgFolder
    .add(PARAMS, "bgVignette", 0, 1, 0.01)
    .onChange((v) => (bgUniforms.uVignette.value = v));
  bgFolder
    .add(PARAMS, "bgGrain", 0, 0.2, 0.005)
    .onChange((v) => (bgUniforms.uGrain.value = v));

  gui.add(actions, "copyConfiguration").name("📋 Copy configuration");

  /* in reduced-motion mode there is no render loop, so paint one frame
     after any edit */
  if (reduceMotion) gui.onChange(() => renderAll());
}

if (window.location.hash === "#editor") initEditor();
window.addEventListener("hashchange", () => {
  if (window.location.hash === "#editor") initEditor();
});

/* ----- interaction + loop ----- */

const pointer = { x: 0, y: 0 };
window.addEventListener("pointermove", (e) => {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
});

function renderAll() {
  bgRenderer.render(bgScene, bgCamera);
  renderer.render(scene, camera);
}

function resize() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  /* the wash is soft gradients; lower resolution is invisible there
     and keeps the second context cheap */
  bgRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  bgRenderer.setSize(w, h, false);
  bgUniforms.uRes.value.set(w, h);
}
window.addEventListener("resize", () => {
  resize();
  if (reduceMotion) renderAll();
});
resize();

/* ----- magnetic CTA -----
   awwwards-style: while hovering, the button leans toward the cursor
   (the label a little less, for depth); on leave both spring home
   with an elastic wobble. Skipped under prefers-reduced-motion. */

const joinBtn = document.querySelector(".mfa-hero__join");
const joinLabel = joinBtn?.querySelector(".mfa-hero__join-label");
if (joinBtn && !reduceMotion) {
  joinBtn.addEventListener("pointerenter", () => {
    gsap.to(joinLabel, { rotation: 0, duration: 0.35, ease: "power2.out" });
  });
  joinBtn.addEventListener("pointermove", (e) => {
    const r = joinBtn.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    gsap.to(joinBtn, {
      x: dx * 0.45,
      y: dy * 0.45,
      duration: 0.4,
      ease: "power3.out",
    });
    gsap.to(joinLabel, {
      x: dx * 0.25,
      y: dy * 0.25,
      duration: 0.4,
      ease: "power3.out",
    });
  });
  joinBtn.addEventListener("pointerleave", () => {
    gsap.to(joinBtn, { x: 0, y: 0, duration: 1, ease: "elastic.out(1, 0.35)" });
    gsap.to(joinLabel, {
      x: 0,
      y: 0,
      rotation: -14,
      duration: 1,
      ease: "elastic.out(1, 0.35)",
    });
  });
}

/* the sculpture's resting spot: just right of centre, snug against
   the intro column like the reference (world units; 1 ≈ 285px) */
const BLOB_HOME_X = 0.05;

if (reduceMotion) {
  /* one still frame, mid-morph so the folds are fully formed */
  uniforms.uTime.value = 8 * PARAMS.morphSpeed;
  bgUniforms.uTime.value = 40;
  mesh.scale.setScalar(PARAMS.scale);
  mesh.position.x = BLOB_HOME_X;
  renderAll();
} else {
  const clock = new THREE.Clock();
  /* eased copy of the raw pointer; mouseEase sets how lazily it trails */
  const smooth = { x: 0, y: 0 };
  const pointerDir = new THREE.Vector3();
  const invQuat = new THREE.Quaternion();
  renderer.setAnimationLoop(() => {
    const dt = clock.getDelta();
    uniforms.uTime.value += dt * PARAMS.morphSpeed;
    bgUniforms.uTime.value += dt;

    smooth.x += (pointer.x - smooth.x) * PARAMS.mouseEase;
    smooth.y += (pointer.y - smooth.y) * PARAMS.mouseEase;

    mesh.scale.setScalar(PARAMS.scale);
    mesh.rotation.y += PARAMS.spinSpeed * dt;
    mesh.rotation.x += (smooth.y * PARAMS.mouseFollow - mesh.rotation.x) * 0.05;
    mesh.rotation.z +=
      (smooth.x * -PARAMS.mouseFollow - mesh.rotation.z) * 0.05;

    /* positional parallax (screen y is inverted vs world y) */
    mesh.position.x = BLOB_HOME_X + smooth.x * PARAMS.mouseParallax;
    mesh.position.y = -smooth.y * PARAMS.mouseParallax;

    /* pointer direction into the mesh's own space for the bulge */
    pointerDir.set(smooth.x * 1.1, -smooth.y * 0.9, 1).normalize();
    invQuat.copy(mesh.quaternion).invert();
    uniforms.uPointerDir.value.copy(pointerDir).applyQuaternion(invQuat);

    bgUniforms.uMouse.value.set(smooth.x, -smooth.y);

    renderAll();
  });
}
