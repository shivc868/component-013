import "./style.css";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import gsap from "gsap";

/* Split-frame hero: a folded-silk sculpture and two colour washes
   render into a texture, then a composite shader draws real
   refractive glass wherever the UI cards sit. */

const PARAMS = {
  // shape — fold geometry, all fed to the vertex shader as uniforms
  lobeFrequency: 0.2, // how many big lobes wrap the sphere
  lobeDepth: 0.04, // how far the lobes push in and out
  ridgeFrequency: 1.12, // density of the fold creases
  ridgeDepth: 0.31, // how tall the creases stand
  edgeSharpness: 3.42, // 0.4 = pillowy melt, 3 = crisp ribbon edges
  shrink: 0.26, // pulls the whole surface inward, keeps it in frame

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

  // material — deep blue metal, self-shaded (no env reflections)
  baseColor: "#2432ff", // tints every reflection
  metalness: 1,
  roughness: 0.12,
  iridescence: 0, // a whisper of oil-slick shift in the folds
  iridescenceIOR: 1,
  clearcoat: 0, // lacquer layer, the glassy top sheen
  clearcoatRoughness: 0,
  envIntensity: 1, // studio reflection strength (0 = unlit black metal)
  exposure: 2.1,

  // studio — the coloured softboxes the chrome reflects; on a
  // full-metal surface this IS the paint job
  keyColor: "#00ff55", // big panel, up-left — the hot emerald key
  fillColor: "#7dffb0", // pale mint fill, right
  backdropColor: "#d6a9ca", // dusty pink behind
  stripAColor: "#12d94f", // thin strip, low front
  stripBColor: "#ccffde", // thin strip, back-left — pale rim light
  sparkColor: "#a76c6c", // small slash for dusty-rose highlights
  ambienceColor: "#010704", // studio background wash

  // view
  scale: 0.86,

  // logo — the GLTF mark in the left panel. Colour/finish follow the
  // model's own exported material: warm amber satin.
  logoColor: "#00d652",
  logoMetalness: 0.75,
  logoRoughness: 0.34, // 0 = mirror, 0.3 = satin
  logoClearcoat: 0.6, // lacquer layer strength
  logoClearcoatRoughness: 0.94,
  logoEnvIntensity: 1, // studio reflection strength on the mark
  logoScale: 0.63, // multiplier on the auto-fitted size
  logoX: 0, // world-unit offsets from the panel centre
  logoY: 0,
  logoPitch: 0, // standard pose: upright, face-on, star bottom-right
  logoYaw: 4.47681469282041, // faces the far side: cancels the baked 45° + half turn
  logoRoll: Math.PI / 2, // flips the mirrored export the right way up

  // glass — the composite pass under the UI cards
  glassBlur: 4.5, // frost radius, px
  glassRefract: 14, // how far the image bows near the pane edges, px
  glassChroma: 0.28, // chromatic fringing on the refracted layer
  glassTint: 0.62, // how smoked the pane is
  glassBrightness: 1.18, // light concentration inside the glass
  glassSheen: 0.028, // the top-left specular wash (linear space)
  glassFrost: 0.003, // per-pixel frost grain

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

/* the right panel wash: same shader, tuned dark */
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

/* no WebGL: show why instead of a silent black stage */
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
/* tone mapping is applied in the materials; the composite pass encodes sRGB */
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

/* resting spot: dead centre of the right panel */
const BLOB_HOME = { x: 0, y: 0 };

/* ----- logo scene (left panel, drawn sharp on top of the glass) ----- */

const logoScene = new THREE.Scene();
const logoCamera = new THREE.PerspectiveCamera(35, 1, 0.1, 20);
logoCamera.position.set(0, 0, 5);

/* neutral lighting so the mark keeps its own colour */
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

/* with scene.environment set, the scene's intensity wins over the material's */
blobScene.environmentIntensity = PARAMS.envIntensity;
logoScene.environmentIntensity = PARAMS.logoEnvIntensity;

/* ----- the GLTF logo: logoRig holds position + scale, logoGroup the pose ----- */

const logoRig = new THREE.Group();
logoScene.add(logoRig);

const logoGroup = new THREE.Group();
logoRig.add(logoGroup);

/* high-gloss chrome under a lacquer clearcoat */
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
      /* re-weld the exporter's split vertices so the shading rolls smoothly */
      let g = node.geometry;
      g.deleteAttribute("normal");
      g.deleteAttribute("uv");
      g = mergeVertices(g);
      g.computeVertexNormals();
      node.geometry = g;
      node.material = logoMaterial;
    });

    /* centre on the origin and fit the longest side to the frame */
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    model.position.sub(center);
    /* turn the thinnest axis toward the camera so the mark reads face-on */
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
  /* pointer direction in object space; the surface swells toward it */
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

/* Ashima 3D simplex noise */
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

/* radial displacement: big lobes + creases */
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

/* ACES fit by hand, so it also applies when rendering into the texture */
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

/* same fit for the logo, which draws straight to the screen */
logoMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uExposure = uniforms.uExposure;
  shader.fragmentShader = acesGLSL + shader.fragmentShader;
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <tonemapping_fragment>",
    "gl_FragColor.rgb = customACES(gl_FragColor.rgb);",
  );
};

/* detail 96 = ~184k triangles */
const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 96), material);
blobScene.add(mesh);

/* ----- washes: a quad per panel, four glow spots smeared by noise ----- */

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

/* ----- glass composite: refraction, frost blur, tint and edge light
   inside each card's rect ----- */

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

/* the glass pane behind the mark — also the clip box for pass 3 */
const logoPaneEl = stage.querySelector(".mfa-hero__logo-pane");

/* the DOM elements the shader mirrors */
const glassEls = [
  logoPaneEl,
  stage.querySelector(".mfa-hero__card--main"),
  ...stage.querySelectorAll(".mfa-hero__btn"),
  ...stage.querySelectorAll(".mfa-hero__card--stat"),
].slice(0, GLASS_COUNT);

function updateGlassRects() {
  const hero = stage.getBoundingClientRect();
  const dpr = renderer.getPixelRatio();
  glassEls.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    /* read the inline style gsap writes: no forced recalc per frame */
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

/* physical px for the blob's scissor, CSS px for the logo's screen pass */
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

  /* confine the sculpture to the right panel; a target's viewport is
     only read inside setRenderTarget, so re-apply it after each change */
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

  /* pass 3: the logo, sharp on top, scissored to its glass pane */
  renderer.autoClear = false;
  renderer.clearDepth();
  renderer.setViewport(
    logoRectCss.x,
    logoRectCss.y,
    logoRectCss.w,
    logoRectCss.h,
  );
  const heroRect = stage.getBoundingClientRect();
  const paneRect = logoPaneEl.getBoundingClientRect();
  renderer.setScissor(
    paneRect.left - heroRect.left,
    heroRect.bottom - paneRect.bottom,
    paneRect.width,
    paneRect.height,
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

/* ----- interaction ----- */

const pointer = { x: 0, y: 0 };
window.addEventListener("pointermove", (e) => {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
});

/* ----- orbit control: drag the left panel to fly around the mark ----- */

function applyStaticLogoPose() {
  logoGroup.rotation.set(PARAMS.logoPitch, PARAMS.logoYaw, PARAMS.logoRoll);
}
applyStaticLogoPose();

const orbit = new OrbitControls(logoCamera, leftPanel);
orbit.enableDamping = true;
orbit.dampingFactor = 0.06;
orbit.enablePan = false;
/* single-screen page again: the wheel is free for zooming the mark */
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

/* ----- dropdown menu: a glass box growing out of the Menu button ----- */

const menuBtn = stage.querySelector(".mfa-hero__menu");
const menuPanel = stage.querySelector(".mfa-hero__menu-panel");
const menuLinks = [...menuPanel.querySelectorAll(".mfa-hero__menu-link")];

/* keep nav pointerdowns from OrbitControls: its pointer capture
   would swallow the button's click */
[stage.querySelector(".mfa-hero__nav"), menuPanel].forEach((el) =>
  el.addEventListener("pointerdown", (e) => e.stopPropagation()),
);
let menuOpen = false;
let menuTl = null;

function openMenu() {
  menuOpen = true;
  menuBtn.setAttribute("aria-expanded", "true");
  if (menuTl) menuTl.kill();
  if (reduceMotion) {
    gsap.set(menuPanel, { autoAlpha: 1, clipPath: "inset(0% 0% 0% 0%)" });
    gsap.set(menuLinks, { autoAlpha: 1, y: 0 });
    return;
  }
  menuTl = gsap
    .timeline({ defaults: { ease: "power4.out" } })
    .set(menuPanel, { autoAlpha: 1 })
    .fromTo(
      menuPanel,
      { clipPath: "inset(0% 100% 100% 0%)" },
      { clipPath: "inset(0% 0% 0% 0%)", duration: 0.55 },
    )
    .fromTo(
      menuLinks,
      { y: 16, autoAlpha: 0 },
      { y: 0, autoAlpha: 1, duration: 0.5, stagger: 0.07 },
      "-=0.3",
    );
}

function closeMenu() {
  menuOpen = false;
  menuBtn.setAttribute("aria-expanded", "false");
  if (menuTl) menuTl.kill();
  if (reduceMotion) {
    gsap.set(menuPanel, { autoAlpha: 0 });
    return;
  }
  menuTl = gsap
    .timeline({ defaults: { ease: "power3.in" } })
    .to(menuLinks, { y: -10, autoAlpha: 0, duration: 0.25, stagger: 0.035 })
    .to(
      menuPanel,
      { clipPath: "inset(0% 100% 100% 0%)", duration: 0.4 },
      "-=0.15",
    )
    .set(menuPanel, { autoAlpha: 0 });
}

menuBtn.addEventListener("click", (e) => {
  e.stopPropagation(); /* keep the document listener from re-closing */
  menuOpen ? closeMenu() : openMenu();
});
menuLinks.forEach((link) => link.addEventListener("click", closeMenu));
document.addEventListener("click", (e) => {
  if (menuOpen && !menuPanel.contains(e.target)) closeMenu();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && menuOpen) closeMenu();
});

/* label scramble on hover/focus */

const SCRAMBLE_GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&";

menuLinks.forEach((link) => {
  const label = link.querySelector("span");
  const original = label.textContent;
  let scrambleTween = null;

  const scramble = () => {
    if (reduceMotion) return;
    if (scrambleTween) scrambleTween.kill();
    const state = { p: 0 };
    scrambleTween = gsap.to(state, {
      p: 1,
      duration: 0.6,
      ease: "none",
      onUpdate() {
        const locked = Math.floor(state.p * original.length);
        let text = "";
        for (let i = 0; i < original.length; i++) {
          text +=
            i < locked || original[i] === " "
              ? original[i]
              : SCRAMBLE_GLYPHS[(Math.random() * SCRAMBLE_GLYPHS.length) | 0];
        }
        label.textContent = text;
      },
      onComplete() {
        label.textContent = original; /* always land on the real label */
      },
    });
  };

  link.addEventListener("mouseenter", scramble);
  link.addEventListener("focus", scramble);
});

/* magnetic buttons: lean toward the cursor, spring home on leave */
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

/* ----- stat counters: every [data-count] ticks up during the intro ----- */

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

const loader = document.querySelector(".mfa-loader");

if (reduceMotion) {
  loader.remove(); /* no boot sequence, straight to the still page */
  /* one still frame, mid-morph so the folds are fully formed */
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
  /* intro: panels iris open → chrome → headline → cards → slot meter.
     Paused; the boot loader plays it once the slats lift. */
  const tl = gsap.timeline({ paused: true, defaults: { ease: "power4.out" } });

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

  /* ----- boot loader: count to 100, lift the slats, start the intro ----- */
  const bootProgress = { v: 0 };
  const countEl = loader.querySelector(".mfa-loader__count");
  const barEl = loader.querySelector(".mfa-loader__bar i");

  gsap
    .timeline({ defaults: { ease: "power4.inOut" } })
    .from([".mfa-loader__brand", ".mfa-loader__status", ".mfa-loader__bar"], {
      y: -12,
      autoAlpha: 0,
      duration: 0.55,
      stagger: 0.08,
      ease: "power3.out",
    })
    .to(
      bootProgress,
      {
        v: 100,
        duration: 2.1,
        ease: "power2.inOut",
        onUpdate() {
          const v = Math.round(bootProgress.v);
          countEl.textContent = String(v).padStart(3, "0") + "%";
          barEl.style.transform = `scaleX(${v / 100})`;
        },
      },
      "<",
    )
    .to(".mfa-loader__content", { autoAlpha: 0, duration: 0.4, ease: "power2.in" }, "+=0.15")
    .to(".mfa-loader__slat", { yPercent: -100, duration: 0.85, stagger: 0.09 }, "-=0.1")
    .add(() => {
      /* the intro starts while the last slat is still leaving */
      tl.play();
      animateCounters();
    }, "-=0.35")
    .add(() => loader.remove());

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
  /* eased copy of the raw pointer */
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

    /* home position + parallax (screen y is inverted vs world y) */
    mesh.position.x = BLOB_HOME.x + smooth.x * PARAMS.mouseParallax;
    mesh.position.y = BLOB_HOME.y - smooth.y * PARAMS.mouseParallax;

    /* the mark holds its pose; only the camera moves */
    applyStaticLogoPose();
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
