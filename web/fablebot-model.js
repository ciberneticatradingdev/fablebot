// fablebot-model.js — fablebot: Clawd (Anthropic's Claude Code mascot) as a streamer.
// Anatomy (matching the streamer-toy reference): big Clawd head (wide orange
// rounded box, small black square eyes set high, side tabs) sitting on a proper
// hoodie TORSO — a tall, soft black garment with sleeves, orange hands, kangaroo
// pocket, drawstrings and a small orange V at the neckline — plus four short
// orange legs. Headphones + boom mic (glows orange when speaking) on the head.
// Returns { group, update(t,{speaking}) } via createFablebot(), or a full staged
// scene via mountScene(canvas).
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

export const PALETTE = {
  orange: 0xd9663f,
  orangeDeep: 0xc85a35,
  fabric: 0x211c18,
  hp: 0x131009,
  eye: 0x121212,
  cream: 0xf0eee6,
};

function clayMat(color, rough = 0.94) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.0 });
}
function rbox(w, h, d, r, mat) {
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 5, r), mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

export function createFablebot() {
  const group = new THREE.Group();

  const matBody = clayMat(PALETTE.orange, 0.93);
  const matFabric = clayMat(PALETTE.fabric, 0.8);
  const matHP = clayMat(PALETTE.hp, 0.55);
  const matEye = new THREE.MeshStandardMaterial({ color: PALETTE.eye, roughness: 0.4 });
  const matOrange = clayMat(PALETTE.orangeDeep, 0.88);
  const matMic = new THREE.MeshStandardMaterial({ color: PALETTE.hp, roughness: 0.45 });

  // ---------- HEAD — the Clawd box ----------
  const head = new THREE.Group();
  group.add(head);

  const skull = rbox(2.6, 1.9, 1.7, 0.26, matBody);
  skull.position.y = 1.9;
  head.add(skull);

  // side tabs the headphones clamp onto
  for (const sx of [-1, 1]) {
    const tab = rbox(0.32, 0.6, 0.7, 0.09, matBody);
    tab.position.set(sx * 1.38, 2.08, 0.02);
    head.add(tab);
  }

  // eyes — small black squares, high and wide apart
  const eyes = [];
  for (const sx of [-1, 1]) {
    const eye = rbox(0.28, 0.28, 0.14, 0.04, matEye);
    eye.position.set(sx * 0.58, 2.24, 0.88);
    head.add(eye);
    eyes.push(eye);
  }

  // ---------- TORSO — the hoodie, a real garment with height ----------
  const torso = new THREE.Group();
  group.add(torso);

  const chest = rbox(2.35, 1.75, 1.55, 0.42, matFabric);
  chest.position.y = 0.12;
  torso.add(chest);

  // soft hood bump resting on the back shoulders
  const hood = rbox(1.7, 0.7, 0.6, 0.26, matFabric);
  hood.position.set(0, 0.85, -0.72);
  torso.add(hood);

  // plain chest — just the two orange drawstrings hanging from the neckline
  for (const sx of [-1, 1]) {
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.45, 10), matOrange);
    cord.position.set(sx * 0.42, 0.62, 0.82);
    cord.castShadow = true;
    torso.add(cord);
    const tip = rbox(0.1, 0.15, 0.1, 0.03, matOrange);
    tip.position.set(sx * 0.42, 0.34, 0.82);
    torso.add(tip);
  }

  // sleeves with little orange hands
  const arms = [];
  for (const sx of [-1, 1]) {
    const arm = new THREE.Group();
    const sleeve = rbox(0.56, 1.25, 0.75, 0.22, matFabric);
    arm.add(sleeve);
    const hand = rbox(0.36, 0.32, 0.44, 0.1, matBody);
    hand.position.y = -0.75;
    arm.add(hand);
    arm.position.set(sx * 1.38, 0.15, 0.05);
    arm.rotation.z = sx * 0.05;
    torso.add(arm);
    arms.push(arm);
  }

  // ---------- LEGS — four short posts growing out of the torso ----------
  // parented to the torso and overlapping well into it, so body and legs
  // read (and sway) as one connected piece
  for (const [x, z] of [[-0.82, 0.2], [-0.28, 0.26], [0.28, 0.26], [0.82, 0.2]]) {
    const leg = rbox(0.42, 0.85, 0.48, 0.1, matBody);
    leg.position.set(x, -0.88, z); // top sits ~0.3 inside the hoodie
    torso.add(leg);
  }

  // ---------- HEADPHONES ----------
  const band = new THREE.Mesh(new THREE.TorusGeometry(1.56, 0.1, 16, 48, Math.PI), matHP);
  band.position.set(0, 2.08, 0.02);
  band.castShadow = true;
  head.add(band);
  for (const sx of [-1, 1]) {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.38, 28), matHP);
    cup.rotation.z = Math.PI / 2;
    cup.position.set(sx * 1.6, 2.08, 0.02);
    cup.castShadow = true;
    head.add(cup);
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.14, 24), matHP);
    pad.rotation.z = Math.PI / 2;
    pad.position.set(sx * 1.79, 2.08, 0.02);
    head.add(pad);
  }
  // boom mic from the left cup to just under the face
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-1.6, 1.82, 0.25),
    new THREE.Vector3(-1.45, 1.35, 0.8),
    new THREE.Vector3(-0.85, 1.18, 1.05),
    new THREE.Vector3(-0.3, 1.24, 1.08),
  ]);
  const boom = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.05, 10, false), matHP);
  boom.castShadow = true;
  head.add(boom);
  const micBall = new THREE.Mesh(new THREE.SphereGeometry(0.14, 20, 20), matMic);
  micBall.position.set(-0.26, 1.24, 1.1);
  head.add(micBall);

  // ---------- animation ----------
  let blinkT = 1.5, blinking = 0;

  function update(t, opts = {}) {
    const speaking = !!opts.speaking;
    // idle breathing bob
    group.position.y = Math.sin(t * 1.3) * 0.045;
    // head nods (stronger when speaking); torso counter-sways gently
    head.rotation.x = Math.sin(t * (speaking ? 4.2 : 1.0)) * (speaking ? 0.06 : 0.02);
    head.rotation.y = Math.sin(t * 0.45) * 0.09;
    torso.rotation.y = Math.sin(t * 0.45) * 0.04;
    // sleeves swing slightly
    arms[0].rotation.x = Math.sin(t * 1.3 + 1) * 0.05;
    arms[1].rotation.x = Math.sin(t * 1.3) * 0.05;
    // blink
    blinkT -= 0.016;
    if (blinkT <= 0) { blinking = 1; blinkT = 2 + Math.random() * 3; }
    if (blinking > 0) {
      blinking -= 0.12;
      const sy = Math.max(0.1, Math.abs(Math.cos(blinking * Math.PI)));
      eyes.forEach(e => (e.scale.y = sy));
      if (blinking <= 0) eyes.forEach(e => (e.scale.y = 1));
    }
    // mic on-air glow
    matMic.emissive.setHex(speaking ? 0xd9663f : 0x000000);
    matMic.emissiveIntensity = speaking ? (0.55 + Math.sin(t * 12) * 0.3) : 0;
  }

  return { group, update, eyes };
}

// Full ready-to-render scene (lights + shadow ground + framing).
export function mountScene(canvas, { transparent = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: transparent });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  if (!transparent) renderer.setClearColor(PALETTE.cream, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  camera.position.set(0, 1.6, 13);
  camera.lookAt(0, 1.05, 0);

  // soft clay studio light
  scene.add(new THREE.HemisphereLight(0xfff6ec, 0xe8ddc9, 0.55));
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const key = new THREE.DirectionalLight(0xfff1e2, 1.35);
  key.position.set(5, 9, 7);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1; key.shadow.camera.far = 40;
  key.shadow.camera.left = -8; key.shadow.camera.right = 8;
  key.shadow.camera.top = 8; key.shadow.camera.bottom = -8;
  key.shadow.bias = -0.0004; key.shadow.radius = 6;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.35); fill.position.set(-7, 3, 5); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffe9d6, 0.4); rim.position.set(0, 5, -8); scene.add(rim);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ opacity: 0.13 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.31;
  ground.receiveShadow = true;
  scene.add(ground);

  const bot = createFablebot();
  scene.add(bot.group);

  function resize() {
    const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  const clock = new THREE.Clock();
  let speaking = false;
  function loop() {
    requestAnimationFrame(loop);
    bot.update(clock.getElapsedTime(), { speaking });
    renderer.render(scene, camera);
  }
  resize(); addEventListener("resize", resize); loop();

  return { setSpeaking: (v) => { speaking = v; }, resize, scene, camera, renderer, bot };
}
