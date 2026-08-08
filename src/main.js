import "./style.css";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import GUI from "lil-gui";
import gsap from "gsap";

/* Red-lit "folded silk" sculpture inside the left panel of a
   split-frame hero, with REAL WebGL glass under the UI cards.

   One canvas, one renderer, two passes:
     1. backdrop — both panel washes + the sculpture render into a
        texture (the washes are quads placed over each panel's rect,
        the sculpture is scissored to the left panel);
     2. composite — a full-screen shader draws that texture, and
        wherever a UI card sits (the DOM rects are mirrored into the
        shader every frame) it refracts, frost-blurs, tints and
        edge-lights the backdrop like a pane of smoked glass.

   Every knob lives in PARAMS; add #editor to the URL for a live
   lil-gui panel and a Copy configuration button. */

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
  spinSpeed: 0.22, // idle rotation, radians/s

  // mouse interaction
  mouseFollow: 0.22, // tilt toward the pointer
  mouseEase: 0.04, // how lazily everything follows the pointer
  mouseParallax: 0.16, // the sculpture drifts toward the pointer
  mouseBulge: 0.24, // the surface swells on the pointer's side
  mouseBulgeSize: 0.2, // how wide that swell spreads
  bgMouseFollow: 0.35, // wash glows lean toward the pointer

  // material — green silk chrome
  baseColor: "#2be368", // tints every reflection
  metalness: 0.78,
  roughness: 0.12,
  iridescence: 0.12, // a whisper of oil-slick shift in the folds
  iridescenceIOR: 1.5,
  clearcoat: 0.25, // lacquer layer, the glassy top sheen
  clearcoatRoughness: 0.85,
  envIntensity: 1.25,
  exposure: 2.1,

  // studio — the coloured softboxes the chrome reflects; on a
  // full-metal surface this IS the paint job
  keyColor: "#00ff55", // big panel, up-left — the hot emerald key
  fillColor: "#7dffb0", // pale mint fill, right
  backdropColor: "#02180a", // near-black green behind
  stripAColor: "#12d94f", // thin strip, low front
  stripBColor: "#ccffde", // thin strip, back-left — pale rim light
  sparkColor: "#efffF4", // small slash for hot white highlights
  ambienceColor: "#010704", // studio background wash

  // view
  scale: 0.83,

  // logo — the GLTF mark in the left panel. Colour/finish follow the
  // model's own exported material: warm amber satin.
  logoColor: "#00d652",
  logoMetalness: 0.45,
  logoRoughness: 0.3, // 0 = mirror, 0.3 = satin
  logoClearcoat: 0.6, // lacquer layer strength
  logoClearcoatRoughness: 0.2,
  logoEnvIntensity: 0.4, // green studio reflections as accent only
  logoScale: 0.63, // multiplier on the auto-fitted size
  logoX: 0, // world-unit offsets from the panel centre
  logoY: 0,
  logoPitch: 0, // standard pose: upright, face-on, star bottom-right
  logoYaw: 4.5, // faces the far side: cancels the baked 45° + half turn
  logoRoll: Math.PI / 2, // flips the mirrored export the right way up
  logoSway: 0.05, // idle breathing tilt, radians (rides under the orbit)

  // glass — the composite pass under the UI cards
  glassBlur: 11, // frost radius, px
  glassRefract: 14, // how far the image bows near the pane edges, px
  glassChroma: 0.28, // chromatic fringing on the refracted layer
  glassTint: 0.62, // how smoked the pane is
  glassBrightness: 1.06, // light concentration inside the glass
  glassSheen: 0.01, // the top-left specular wash (linear space)
  glassFrost: 0.012, // per-pixel frost grain

  // left wash — the glow field behind the logo stage
  bgBase: "#081109", // floor colour the glows sit on
  bgColor1: "#12b56e", // sea green, upper left
  bgColor2: "#ff00bb", // hot magenta, upper right
  bgColor3: "#baff52", // acid lime, lower right
  bgColor4: "#ff0000", // pure red, lower left
  bgSpeed: 0.5,
  bgScale: 2.6,
  bgWarp: 1.35, // how much the noise smears the glows around
  bgBrightness: 0.95,
  bgSpotSize: 0.95,
  bgVignette: 0.5,
  bgGrain: 0.16,
};

/* the right panel's silk smear reuses the same wash shader, tuned
   dark: one crimson streak floating in near-black */
const RIGHT_WASH = {
  bgBase: "#040504",
  bgColor1: "#00a844",
  bgColor2: "#1ad95f",
  bgColor3: "#012a10",
  bgColor4: "#011607",
  bgSpeed: 0.35,
  bgScale: 2.2,
  bgWarp: 2.0,
  bgBrightness: 0.6,
  bgSpotSize: 0.85,
  bgVignette: 0.62,
  bgGrain: 0.14,
};

const FRAME_COLOR = new THREE.Color("#060806");

const stage = document.querySelector(".mfa-hero");
const leftPanel = stage.querySelector(".mfa-hero__panel--left");
const rightPanel = stage.querySelector(".mfa-hero__panel--right");
const canvas = stage.querySelector(".mfa-hero__canvas");

const reduceMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;

/* WebGL can be unavailable (graphics acceleration disabled, blocklisted
   GPU, remote desktop). Fail with a visible explanation instead of a
   silent black stage and an uncaught error. The CSS backdrop-filter
   glass stays active as the fallback in that case. */
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
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
/* tone mapping is injected into the blob material by hand (so it also
   applies when rendering into the texture); the composite shader does
   the final linear → sRGB conversion for everything */
renderer.toneMapping = THREE.NoToneMapping;
stage.classList.add("mfa-hero--gl");

/* ----- backdrop render target ----- */

const backdropRT = new THREE.WebGLRenderTarget(2, 2, {
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  depthBuffer: true,
});

/* NDC camera for the wash quads and the composite quad */
const ndcCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

/* ----- blob scene (right panel, under the content cards) ----- */

const blobScene = new THREE.Scene();
const blobCamera = new THREE.PerspectiveCamera(35, 1, 0.1, 20);
blobCamera.position.set(0, 0, 5);

/* resting spot: dead centre of the right panel — the card cluster
   frosts its upper half through the glass */
const BLOB_HOME = { x: 0, y: 0 };

/* ----- logo scene (left panel, drawn sharp on top of the glass) ----- */

const logoScene = new THREE.Scene();
const logoCamera = new THREE.PerspectiveCamera(35, 1, 0.1, 20);
logoCamera.position.set(0, 0, 5);

/* neutral studio lighting for the mark: its amber must stay amber,
   so white lights carry the shading and the green environment only
   accents the speculars */
const logoKeyLight = new THREE.DirectionalLight(0xffffff, 2.4);
logoKeyLight.position.set(2, 3, 4);
logoScene.add(logoKeyLight);
logoScene.add(new THREE.AmbientLight(0xffffff, 0.5));

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
  blobScene.environment = envTexture;
  logoScene.environment = envTexture;
  if (old) old.dispose();
}
rebuildStudio();

/* ----- the GLTF logo, floating over the flat glass panel -----
   logoRig carries position + scale, logoGroup carries the mark's own
   pose. OrbitControls flies the camera around the rig, so the mark
   is inspectable from every side. */

const logoRig = new THREE.Group();
logoScene.add(logoRig);

const logoGroup = new THREE.Group();
logoRig.add(logoGroup);

/* same green-lit chrome family as the blob, but high-gloss: mirror
   roughness under a full lacquer clearcoat */
const logoMaterial = new THREE.MeshPhysicalMaterial({
  color: PARAMS.logoColor,
  metalness: PARAMS.logoMetalness,
  roughness: PARAMS.logoRoughness,
  clearcoat: PARAMS.logoClearcoat,
  clearcoatRoughness: PARAMS.logoClearcoatRoughness,
  envMapIntensity: PARAMS.logoEnvIntensity,
});

/* auto-fit scale from the loaded model; logoScale multiplies it */
let logoBaseScale = 1;

function applyLogoTransform() {
  logoRig.scale.setScalar(logoBaseScale * PARAMS.logoScale);
  logoRig.position.set(PARAMS.logoX, PARAMS.logoY, 0);
}

new GLTFLoader().load(
  "/assets/logo/logo.gltf",
  (gltf) => {
    const model = gltf.scene;
    model.traverse((node) => {
      if (!node.isMesh) return;
      /* soften the extrusion edges: exporters split vertices per face
         (flat shading). Re-weld them and rebuild averaged normals so
         the shading rolls smoothly over every edge. UVs are dropped —
         they block welding and pure chrome never samples a texture. */
      let g = node.geometry;
      g.deleteAttribute("normal");
      g.deleteAttribute("uv");
      g = mergeVertices(g);
      g.computeVertexNormals();
      node.geometry = g;
      node.material = logoMaterial;
    });

    /* normalise: centre on the origin, scale the longest side to a
       known size so any exported model fits the frame */
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    model.position.sub(center);
    /* a logo is an extrusion: its thinnest dimension is its depth.
       Turn that axis toward the camera so the mark reads face-on,
       whatever way it was exported. */
    if (size.x < size.y && size.x < size.z) {
      model.rotation.y = Math.PI / 2;
    } else if (size.y < size.x && size.y < size.z) {
      model.rotation.x = Math.PI / 2;
    }
    logoBaseScale = 1.15 / Math.max(size.x, size.y, size.z);
    applyLogoTransform();
    logoGroup.add(model);

    if (reduceMotion) renderAll(); /* static page: repaint with the mark */
  },
  undefined,
  (err) => console.error("logo.gltf failed to load", err),
);

/* ----- blob material + deforming shader ----- */

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
  uExposure: { value: PARAMS.exposure },
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
const simplexGLSL = /* glsl */ `
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
`;

const deformGLSL = /* glsl */ `
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

/* three's own ACES fit, applied by hand so it works identically when
   rendering into the backdrop texture (the renderer's tone mapping
   pass only runs for the default framebuffer) */
const acesGLSL = /* glsl */ `
uniform float uExposure;
vec3 RRTAndODTFit(vec3 v){
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 customACES(vec3 color){
  const mat3 inMat = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777)
  );
  const mat3 outMat = mat3(
    vec3( 1.60475, -0.10208, -0.00327),
    vec3(-0.53108,  1.10813, -0.07276),
    vec3(-0.07367, -0.00605,  1.07602)
  );
  color *= uExposure / 0.6;
  color = outMat * RRTAndODTFit(inMat * color);
  return clamp(color, 0.0, 1.0);
}
`;

material.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = simplexGLSL + deformGLSL + shader.vertexShader;
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <beginnormal_vertex>",
      "vec3 objectNormal = blobNormal(position);",
    )
    .replace("#include <begin_vertex>", "vec3 transformed = deform(position);");
  shader.fragmentShader = acesGLSL + shader.fragmentShader;
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <tonemapping_fragment>",
    "gl_FragColor.rgb = customACES(gl_FragColor.rgb);",
  );
};

/* the logo draws straight to the screen, which also skips the
   renderer's tone mapping — inject the same ACES fit */
logoMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uExposure = uniforms.uExposure;
  shader.fragmentShader = acesGLSL + shader.fragmentShader;
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <tonemapping_fragment>",
    "gl_FragColor.rgb = customACES(gl_FragColor.rgb);",
  );
};

/* detail 96 = ~184k triangles: plenty for the low-frequency folds and
   comfortably 60fps territory on mid-range GPUs */
const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 96), material);
blobScene.add(mesh);

/* ----- washes (backdrop pass) -----
   Each wash is a quad placed over its panel's rect in NDC; the
   fragment shader drifts four coloured glow spots around and smears
   them with simplex noise. Output is converted to linear so the
   whole backdrop texture lives in one colour space. */

const washFragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uBase, uC1, uC2, uC3, uC4;
uniform float uSpeed, uScale, uWarp, uBrightness, uSpotSize, uVignette, uGrain;
uniform vec2 uMouse;
uniform float uMouseAmt;

${simplexGLSL}

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
  /* faint heart so the centre never goes dead black */
  col += uC1 * uBrightness * 0.22 * glow(q, vec2(0.0, -0.05), uSpotSize * 1.35);

  /* corner fade */
  vec2 v = vUv - 0.5;
  col *= 1.0 - uVignette * smoothstep(0.15, 0.75, dot(v, v) * 2.0);

  /* animated grain hides gradient banding */
  float g = fract(sin(dot(gl_FragCoord.xy + mod(uTime, 100.0) * 60.0, vec2(12.9898, 78.233))) * 43758.5453);
  col += (g - 0.5) * uGrain;

  /* into linear space; the composite pass encodes back to sRGB */
  gl_FragColor = vec4(pow(max(col, 0.0), vec3(2.2)), 1.0);
}
`;

const washScene = new THREE.Scene();

function createWash(cfg) {
  const washUniforms = {
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uBase: { value: new THREE.Color(cfg.bgBase) },
    uC1: { value: new THREE.Color(cfg.bgColor1) },
    uC2: { value: new THREE.Color(cfg.bgColor2) },
    uC3: { value: new THREE.Color(cfg.bgColor3) },
    uC4: { value: new THREE.Color(cfg.bgColor4) },
    uSpeed: { value: cfg.bgSpeed },
    uScale: { value: cfg.bgScale },
    uWarp: { value: cfg.bgWarp },
    uBrightness: { value: cfg.bgBrightness },
    uSpotSize: { value: cfg.bgSpotSize },
    uVignette: { value: cfg.bgVignette },
    uGrain: { value: cfg.bgGrain },
    uMouse: { value: new THREE.Vector2(0, 0) },
    uMouseAmt: { value: PARAMS.bgMouseFollow },
  };

  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      uniforms: washUniforms,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main(){
          vUv = position.xy * 0.5 + 0.5;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: washFragment,
      depthTest: false,
      depthWrite: false,
    }),
  );
  quad.position.z = -0.5;
  washScene.add(quad);
  return { quad, uniforms: washUniforms };
}

const leftWash = createWash(PARAMS);
const rightWash = createWash(RIGHT_WASH);

/* ----- glass composite pass -----
   Draws the backdrop texture to the screen. Inside each card's rect:
   refraction (the image bows toward the pane centre near the edges),
   12-tap rotated-poisson frost blur, a semi-sharp refracted layer
   with chromatic fringing, smoked tint, top-left specular sheen,
   inner edge light and frost grain — then the final sRGB encode. */

const GLASS_COUNT = 6;

const glassUniforms = {
  uTex: { value: backdropRT.texture },
  uRes: { value: new THREE.Vector2(1, 1) },
  uRects: {
    value: Array.from({ length: GLASS_COUNT }, () => new THREE.Vector4()),
  },
  uAlphas: { value: new Array(GLASS_COUNT).fill(0) },
  uBlur: { value: PARAMS.glassBlur },
  uRefract: { value: PARAMS.glassRefract },
  uChroma: { value: PARAMS.glassChroma },
  uTint: { value: PARAMS.glassTint },
  uBrightness: { value: PARAMS.glassBrightness },
  uSheen: { value: PARAMS.glassSheen },
  uFrost: { value: PARAMS.glassFrost },
  uDpr: { value: 1 },
};

const glassScene = new THREE.Scene();
glassScene.add(
  new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: glassUniforms,
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */ `
        out vec2 vUv;
        void main(){
          vUv = position.xy * 0.5 + 0.5;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        #define GLASS_COUNT ${GLASS_COUNT}
        uniform sampler2D uTex;
        uniform vec2 uRes;
        uniform vec4 uRects[GLASS_COUNT];
        uniform float uAlphas[GLASS_COUNT];
        uniform float uBlur, uRefract, uChroma, uTint, uBrightness, uSheen, uFrost;
        uniform float uDpr;
        in vec2 vUv;
        out vec4 outColor;

        const vec2 TAPS[12] = vec2[12](
          vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696,  0.457),
          vec2(-0.203,  0.621), vec2( 0.962, -0.195), vec2( 0.473, -0.480),
          vec2( 0.519,  0.767), vec2( 0.185, -0.893), vec2( 0.507,  0.064),
          vec2( 0.896,  0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598)
        );

        float hash(vec2 p){
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }

        void main(){
          vec2 frag = vUv * uRes;
          vec3 col = texture(uTex, vUv).rgb;

          for (int i = 0; i < GLASS_COUNT; i++) {
            vec4 r = uRects[i];
            float a = uAlphas[i];
            if (a <= 0.001 || r.z <= 1.0) continue;
            vec2 lo = r.xy;
            vec2 hi = r.xy + r.zw;
            if (frag.x < lo.x || frag.x > hi.x || frag.y < lo.y || frag.y > hi.y) continue;

            vec2 local = (frag - lo) / r.zw;      /* 0..1 inside the pane */
            vec2 dpx = min(frag - lo, hi - frag); /* px to nearest edges */
            float edge = min(dpx.x, dpx.y);

            /* refraction: bow toward the centre, strongest at the rim */
            vec2 toC = vec2(0.5) - local;
            float len = max(length(toC), 1e-4);
            float bulge = 1.0 - smoothstep(0.0, 48.0 * uDpr, edge);
            vec2 off = (toC / len) * bulge * bulge * uRefract * uDpr / uRes;

            /* frost: rotated poisson taps */
            float ang = hash(frag) * 6.2831853;
            mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
            vec3 acc = vec3(0.0);
            for (int t = 0; t < 12; t++) {
              vec2 tap = rot * TAPS[t] * uBlur * uDpr / uRes;
              acc += texture(uTex, clamp(vUv + off + tap, 0.0, 1.0)).rgb;
            }
            acc /= 12.0;

            /* a semi-sharp refracted layer with chromatic fringing */
            vec3 sharp;
            sharp.r = texture(uTex, clamp(vUv + off * (1.0 + uChroma), 0.0, 1.0)).r;
            sharp.g = texture(uTex, clamp(vUv + off, 0.0, 1.0)).g;
            sharp.b = texture(uTex, clamp(vUv + off * (1.0 - uChroma), 0.0, 1.0)).b;

            vec3 glass = mix(acc, sharp, 0.22) * uBrightness;

            /* smoked tint (linear-space pane colour, green-cast) */
            glass = mix(glass, vec3(0.0014, 0.0026, 0.0018), uTint);

            /* specular sheen falling from the top-left (~128deg) */
            float diag = local.x * 0.62 + (1.0 - local.y) * 0.79;
            float sheen = (1.0 - smoothstep(0.0, 0.55, diag)) * uSheen;
            sheen += smoothstep(0.95, 1.35, diag) * uSheen * 0.4;
            glass += sheen * vec3(0.88, 1.0, 0.92);

            /* inner edge light: brightest along the top rim */
            glass += vec3(0.02) * (1.0 - smoothstep(0.5, 2.5 * uDpr, hi.y - frag.y));
            glass += vec3(0.006) * (1.0 - smoothstep(0.5, 2.0 * uDpr, edge));

            /* frost grain */
            glass += (hash(frag + 7.7) - 0.5) * uFrost;

            col = mix(col, glass, a);
          }

          outColor = vec4(pow(max(col, vec3(0.0)), vec3(1.0 / 2.2)), 1.0);
        }
      `,
    }),
  ),
);

/* the DOM elements the shader mirrors */
const glassEls = [
  stage.querySelector(".mfa-hero__logo-pane"),
  stage.querySelector(".mfa-hero__card--main"),
  ...stage.querySelectorAll(".mfa-hero__btn"),
  ...stage.querySelectorAll(".mfa-hero__card--stat"),
].slice(0, GLASS_COUNT);

function updateGlassRects() {
  const hero = stage.getBoundingClientRect();
  const dpr = renderer.getPixelRatio();
  glassEls.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    /* gsap's autoAlpha writes inline opacity/visibility; reading the
       inline style avoids a forced style recalc every frame */
    let a = el.style.opacity === "" ? 1 : parseFloat(el.style.opacity);
    if (el.style.visibility === "hidden") a = 0;
    glassUniforms.uRects.value[i].set(
      (r.left - hero.left) * dpr,
      (hero.bottom - r.bottom) * dpr,
      r.width * dpr,
      r.height * dpr,
    );
    glassUniforms.uAlphas.value[i] = a;
  });
}

/* ----- layout: place washes + per-panel viewports ----- */

/* physical px (render-target space) for the blob's scissor,
   CSS px (renderer.setViewport space) for the logo's screen pass */
const blobRectPx = { x: 0, y: 0, w: 0, h: 0 };
const logoRectCss = { x: 0, y: 0, w: 1, h: 1 };

function rightVisible() {
  return rightPanel.offsetParent !== null && rightPanel.clientWidth > 0;
}

function placePanels() {
  const hero = stage.getBoundingClientRect();
  const dpr = renderer.getPixelRatio();

  const place = (wash, rect) => {
    const cx = ((rect.left + rect.width / 2 - hero.left) / hero.width) * 2 - 1;
    const cy = -(
      ((rect.top + rect.height / 2 - hero.top) / hero.height) * 2 -
      1
    );
    wash.quad.position.set(cx, cy, -0.5);
    wash.quad.scale.set(rect.width / hero.width, rect.height / hero.height, 1);
    wash.uniforms.uRes.value.set(rect.width * dpr, rect.height * dpr);
  };

  const lp = leftPanel.getBoundingClientRect();
  place(leftWash, lp);
  logoRectCss.x = lp.left - hero.left;
  logoRectCss.y = hero.bottom - lp.bottom;
  logoRectCss.w = lp.width;
  logoRectCss.h = lp.height;
  logoCamera.aspect = lp.width / Math.max(lp.height, 1);
  logoCamera.updateProjectionMatrix();

  rightWash.quad.visible = rightVisible();
  if (rightWash.quad.visible) {
    const rp = rightPanel.getBoundingClientRect();
    place(rightWash, rp);
    blobRectPx.x = (rp.left - hero.left) * dpr;
    blobRectPx.y = (hero.bottom - rp.bottom) * dpr;
    blobRectPx.w = rp.width * dpr;
    blobRectPx.h = rp.height * dpr;
    blobCamera.aspect = rp.width / Math.max(rp.height, 1);
    blobCamera.updateProjectionMatrix();
  } else {
    blobRectPx.w = 0; /* no right panel (mobile): skip the blob */
  }
}

function resize() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  backdropRT.setSize(size.x, size.y);
  glassUniforms.uRes.value.copy(size);
  glassUniforms.uDpr.value = renderer.getPixelRatio();
  placePanels();
}

function renderAll() {
  updateGlassRects();

  /* pass 1: washes + sculpture into the backdrop texture */
  renderer.setRenderTarget(backdropRT);
  renderer.setClearColor(FRAME_COLOR, 1);
  renderer.render(washScene, ndcCamera); /* autoClear paints the frame */

  /* confine the sculpture to the right panel, under the cards.
     NB: a render target's viewport/scissor are only read inside
     setRenderTarget, so it must be re-applied after mutating them. */
  if (blobRectPx.w > 0) {
    backdropRT.viewport.set(
      blobRectPx.x,
      blobRectPx.y,
      blobRectPx.w,
      blobRectPx.h,
    );
    backdropRT.scissor.set(
      blobRectPx.x,
      blobRectPx.y,
      blobRectPx.w,
      blobRectPx.h,
    );
    backdropRT.scissorTest = true;
    renderer.setRenderTarget(backdropRT);
    renderer.autoClear = false;
    renderer.render(blobScene, blobCamera);
    renderer.autoClear = true;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    backdropRT.viewport.set(0, 0, size.x, size.y);
    backdropRT.scissor.set(0, 0, size.x, size.y);
    backdropRT.scissorTest = false;
  }

  /* pass 2: glass composite to the screen */
  renderer.setRenderTarget(null);
  renderer.render(glassScene, ndcCamera);

  /* pass 3: the logo, sharp ON TOP of the left panel's glass frame */
  renderer.autoClear = false;
  renderer.clearDepth();
  renderer.setViewport(
    logoRectCss.x,
    logoRectCss.y,
    logoRectCss.w,
    logoRectCss.h,
  );
  renderer.setScissor(
    logoRectCss.x,
    logoRectCss.y,
    logoRectCss.w,
    logoRectCss.h,
  );
  renderer.setScissorTest(true);
  renderer.render(logoScene, logoCamera);
  renderer.setScissorTest(false);
  renderer.autoClear = true;
  const css = renderer.getSize(new THREE.Vector2());
  renderer.setViewport(0, 0, css.x, css.y);
}

window.addEventListener("resize", () => {
  resize();
  if (reduceMotion) renderAll();
});
resize();

/* ----- editor panel -----
   dev tool, hidden on the finished page: add #editor to the URL
   (e.g. localhost:5199/#editor) to tune PARAMS live and copy the
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
  mouseFolder.add(PARAMS, "bgMouseFollow", 0, 1, 0.01).onChange((v) => {
    leftWash.uniforms.uMouseAmt.value = v;
    rightWash.uniforms.uMouseAmt.value = v * 0.5;
  });

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
    .onChange((v) => (uniforms.uExposure.value = v));

  const logoFolder = gui.addFolder("Logo");
  logoFolder
    .addColor(PARAMS, "logoColor")
    .onChange((v) => logoMaterial.color.set(v));
  logoFolder
    .add(PARAMS, "logoMetalness", 0, 1, 0.01)
    .onChange((v) => (logoMaterial.metalness = v));
  logoFolder
    .add(PARAMS, "logoRoughness", 0, 1, 0.01)
    .onChange((v) => (logoMaterial.roughness = v));
  logoFolder
    .add(PARAMS, "logoClearcoat", 0, 1, 0.01)
    .onChange((v) => (logoMaterial.clearcoat = v));
  logoFolder
    .add(PARAMS, "logoClearcoatRoughness", 0, 1, 0.01)
    .onChange((v) => (logoMaterial.clearcoatRoughness = v));
  logoFolder
    .add(PARAMS, "logoEnvIntensity", 0, 3, 0.01)
    .onChange((v) => (logoMaterial.envMapIntensity = v));
  logoFolder
    .add(PARAMS, "logoScale", 0.3, 2, 0.01)
    .onChange(applyLogoTransform);
  logoFolder.add(PARAMS, "logoX", -1.5, 1.5, 0.01).onChange(applyLogoTransform);
  logoFolder.add(PARAMS, "logoY", -1.5, 1.5, 0.01).onChange(applyLogoTransform);
  logoFolder.add(PARAMS, "logoPitch", -Math.PI, Math.PI, 0.01).onChange(() => {
    if (reduceMotion) applyStaticLogoPose();
  });
  logoFolder
    .add(PARAMS, "logoYaw", -Math.PI * 2, Math.PI * 2, 0.01)
    .onChange(() => {
      if (reduceMotion) applyStaticLogoPose();
    });
  logoFolder.add(PARAMS, "logoRoll", -Math.PI, Math.PI, 0.01).onChange(() => {
    if (reduceMotion) applyStaticLogoPose();
  });
  logoFolder.add(PARAMS, "logoSway", 0, 0.25, 0.005);

  const glassFolder = gui.addFolder("Glass");
  glassFolder
    .add(PARAMS, "glassBlur", 0, 30, 0.5)
    .onChange((v) => (glassUniforms.uBlur.value = v));
  glassFolder
    .add(PARAMS, "glassRefract", 0, 40, 0.5)
    .onChange((v) => (glassUniforms.uRefract.value = v));
  glassFolder
    .add(PARAMS, "glassChroma", 0, 1.5, 0.01)
    .onChange((v) => (glassUniforms.uChroma.value = v));
  glassFolder
    .add(PARAMS, "glassTint", 0, 1, 0.01)
    .onChange((v) => (glassUniforms.uTint.value = v));
  glassFolder
    .add(PARAMS, "glassBrightness", 0.5, 2, 0.01)
    .onChange((v) => (glassUniforms.uBrightness.value = v));
  glassFolder
    .add(PARAMS, "glassSheen", 0, 0.05, 0.001)
    .onChange((v) => (glassUniforms.uSheen.value = v));
  glassFolder
    .add(PARAMS, "glassFrost", 0, 0.05, 0.001)
    .onChange((v) => (glassUniforms.uFrost.value = v));

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

  const bgFolder = gui.addFolder("Left wash");
  bgFolder
    .addColor(PARAMS, "bgBase")
    .onChange((v) => leftWash.uniforms.uBase.value.set(v));
  bgFolder
    .addColor(PARAMS, "bgColor1")
    .onChange((v) => leftWash.uniforms.uC1.value.set(v));
  bgFolder
    .addColor(PARAMS, "bgColor2")
    .onChange((v) => leftWash.uniforms.uC2.value.set(v));
  bgFolder
    .addColor(PARAMS, "bgColor3")
    .onChange((v) => leftWash.uniforms.uC3.value.set(v));
  bgFolder
    .addColor(PARAMS, "bgColor4")
    .onChange((v) => leftWash.uniforms.uC4.value.set(v));
  bgFolder
    .add(PARAMS, "bgSpeed", 0, 0.6, 0.005)
    .onChange((v) => (leftWash.uniforms.uSpeed.value = v));
  bgFolder
    .add(PARAMS, "bgScale", 0.4, 3, 0.01)
    .onChange((v) => (leftWash.uniforms.uScale.value = v));
  bgFolder
    .add(PARAMS, "bgWarp", 0, 2.5, 0.01)
    .onChange((v) => (leftWash.uniforms.uWarp.value = v));
  bgFolder
    .add(PARAMS, "bgBrightness", 0, 2, 0.01)
    .onChange((v) => (leftWash.uniforms.uBrightness.value = v));
  bgFolder
    .add(PARAMS, "bgSpotSize", 0.2, 2, 0.01)
    .onChange((v) => (leftWash.uniforms.uSpotSize.value = v));
  bgFolder
    .add(PARAMS, "bgVignette", 0, 1, 0.01)
    .onChange((v) => (leftWash.uniforms.uVignette.value = v));
  bgFolder
    .add(PARAMS, "bgGrain", 0, 0.2, 0.005)
    .onChange((v) => (leftWash.uniforms.uGrain.value = v));

  gui.add(actions, "copyConfiguration").name("📋 Copy configuration");

  /* in reduced-motion mode there is no render loop, so paint one frame
     after any edit */
  if (reduceMotion) gui.onChange(() => renderAll());
}

if (window.location.hash === "#editor") initEditor();
window.addEventListener("hashchange", () => {
  if (window.location.hash === "#editor") initEditor();
});

/* ----- interaction ----- */

const pointer = { x: 0, y: 0 };
window.addEventListener("pointermove", (e) => {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
});

/* ----- orbit control -----
   the left panel is the mark's viewport: drag to fly the camera
   around the logo, wheel/pinch to zoom. Damped so it glides. */

function applyStaticLogoPose() {
  logoGroup.rotation.set(PARAMS.logoPitch, PARAMS.logoYaw, PARAMS.logoRoll);
}
applyStaticLogoPose();

const orbit = new OrbitControls(logoCamera, leftPanel);
orbit.enableDamping = true;
orbit.dampingFactor = 0.06;
orbit.enablePan = false;
orbit.minDistance = 2.2;
orbit.maxDistance = 9;
orbit.target.set(PARAMS.logoX, PARAMS.logoY, 0);
orbit.update();

leftPanel.addEventListener("pointerdown", () =>
  stage.classList.add("mfa-hero--grabbing"),
);
leftPanel.addEventListener("pointerup", () =>
  stage.classList.remove("mfa-hero--grabbing"),
);

/* no render loop in reduced-motion mode: paint per orbit change */
if (reduceMotion) orbit.addEventListener("change", renderAll);

/* magnetic buttons: while hovering, the button leans toward the
   cursor; on leave it springs home with an elastic wobble. The glass
   in the shader follows because the rects are re-measured per frame. */
if (!reduceMotion) {
  stage.querySelectorAll(".mfa-hero__btn").forEach((btn) => {
    const inner = btn.querySelector(".mfa-hero__btn-inner");
    btn.addEventListener("pointermove", (e) => {
      const r = btn.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      gsap.to(btn, {
        x: dx * 0.12,
        y: dy * 0.3,
        duration: 0.4,
        ease: "power3.out",
      });
      gsap.to(inner, {
        x: dx * 0.06,
        y: dy * 0.15,
        duration: 0.4,
        ease: "power3.out",
      });
    });
    btn.addEventListener("pointerleave", () => {
      gsap.to([btn, inner], {
        x: 0,
        y: 0,
        duration: 0.9,
        ease: "elastic.out(1, 0.4)",
      });
    });
  });
}

/* ----- stat counters -----
   every [data-count] ticks from 0 to its value during the intro;
   integers get thousands separators ("1,300+"), data-decimals handles
   the 4.9 rating. */

function animateCounters() {
  stage.querySelectorAll("[data-count]").forEach((el) => {
    const target = parseFloat(el.dataset.count);
    const decimals = parseInt(el.dataset.decimals || "0", 10);
    const suffix = el.dataset.suffix || "";
    const state = { v: 0 };
    gsap.to(state, {
      v: target,
      duration: 1.6,
      delay: 0.9,
      ease: "power3.out",
      onUpdate() {
        const value = decimals
          ? state.v.toFixed(decimals)
          : Math.round(state.v).toLocaleString("en-US");
        el.textContent = value + suffix;
      },
    });
  });
}

/* ----- intro ----- */

if (reduceMotion) {
  /* one still frame, mid-morph so the folds are fully formed;
     no from-tweens ran, so all content is simply visible */
  uniforms.uTime.value = 8 * PARAMS.morphSpeed;
  leftWash.uniforms.uTime.value = 40;
  rightWash.uniforms.uTime.value = 40;
  mesh.scale.setScalar(PARAMS.scale);
  mesh.position.set(BLOB_HOME.x, BLOB_HOME.y, 0);
  applyStaticLogoPose(); /* a flattering static angle, drag-adjustable */
  renderAll();
  /* fonts shift the card rects when they arrive; repaint once ready */
  if (document.fonts?.ready) {
    document.fonts.ready.then(() => {
      placePanels();
      renderAll();
    });
  }
} else {
  /* choreography: panels iris open → chrome fades in → headline lines
     slide up → cards and counters land → slot meter ticks on */
  const tl = gsap.timeline({ defaults: { ease: "power4.out" } });

  tl.from(".mfa-hero__panel", {
    clipPath: "inset(50% 0% 50% 0%)",
    duration: 1.15,
    stagger: 0.1,
    ease: "power4.inOut",
    clearProps: "clipPath",
  })
    .from(
      [".mfa-hero__nav", ".mfa-hero__socials"],
      { y: -16, autoAlpha: 0, duration: 0.7 },
      "-=0.45",
    )
    .from(
      ".mfa-hero__logo-pane",
      { scale: 0.92, autoAlpha: 0, duration: 0.9 },
      "-=0.6",
    )
    .from(
      ".mfa-hero__card--main",
      { y: 34, autoAlpha: 0, duration: 0.8 },
      "-=0.55",
    )
    .from(
      ".mfa-hero__line > span",
      { yPercent: 115, duration: 1.0, stagger: 0.1 },
      "-=0.5",
    )
    .from(".mfa-hero__role", { y: 14, autoAlpha: 0, duration: 0.6 }, "-=0.6")
    .from(
      [".mfa-hero__actions .mfa-hero__btn", ".mfa-hero__card--stat"],
      { y: 26, autoAlpha: 0, duration: 0.7, stagger: 0.08 },
      "-=0.7",
    )
    .from(
      ".mfa-hero__slots-ticks i",
      { scaleY: 0, transformOrigin: "bottom", duration: 0.4, stagger: 0.05 },
      "-=0.5",
    )
    .from(
      [
        ".mfa-hero__slots-label",
        ".mfa-hero__slots-month",
        ".mfa-hero__slots-left",
      ],
      { autoAlpha: 0, duration: 0.5 },
      "<",
    )
    .from(".mfa-hero__scroll", { y: 10, autoAlpha: 0, duration: 0.6 }, "-=0.3");

  animateCounters();

  /* scroll cue chevron: a slow idle bob */
  gsap.to(".mfa-hero__scroll svg", {
    y: 3,
    duration: 0.9,
    repeat: -1,
    yoyo: true,
    ease: "sine.inOut",
    delay: 2,
  });

  const clock = new THREE.Clock();
  /* eased copy of the raw pointer; mouseEase sets how lazily it trails */
  const smooth = { x: 0, y: 0 };
  const pointerDir = new THREE.Vector3();
  const invQuat = new THREE.Quaternion();
  renderer.setAnimationLoop(() => {
    const dt = clock.getDelta();
    uniforms.uTime.value += dt * PARAMS.morphSpeed;
    leftWash.uniforms.uTime.value += dt;
    rightWash.uniforms.uTime.value += dt;

    smooth.x += (pointer.x - smooth.x) * PARAMS.mouseEase;
    smooth.y += (pointer.y - smooth.y) * PARAMS.mouseEase;

    mesh.scale.setScalar(PARAMS.scale);
    mesh.rotation.y += PARAMS.spinSpeed * dt;
    mesh.rotation.x += (smooth.y * PARAMS.mouseFollow - mesh.rotation.x) * 0.05;
    mesh.rotation.z +=
      (smooth.x * -PARAMS.mouseFollow - mesh.rotation.z) * 0.05;

    /* home under the cards + positional parallax (screen y is
       inverted vs world y) */
    mesh.position.x = BLOB_HOME.x + smooth.x * PARAMS.mouseParallax;
    mesh.position.y = BLOB_HOME.y - smooth.y * PARAMS.mouseParallax;

    /* the mark rests at its home pose with a slow breathing sway; the
       camera is what moves (OrbitControls damping needs a per-frame
       update) */
    applyStaticLogoPose();
    const t = leftWash.uniforms.uTime.value;
    logoGroup.rotation.x += Math.sin(t * 0.8) * PARAMS.logoSway * 0.6;
    logoGroup.rotation.y += Math.sin(t * 0.55) * PARAMS.logoSway;
    orbit.update();

    /* pointer direction into the mesh's own space for the bulge */
    pointerDir.set(smooth.x * 1.1, -smooth.y * 0.9, 1).normalize();
    invQuat.copy(mesh.quaternion).invert();
    uniforms.uPointerDir.value.copy(pointerDir).applyQuaternion(invQuat);

    leftWash.uniforms.uMouse.value.set(smooth.x, -smooth.y);
    rightWash.uniforms.uMouse.value.set(smooth.x * 0.5, -smooth.y * 0.5);

    renderAll();
  });
}
