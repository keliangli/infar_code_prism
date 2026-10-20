import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  FILE_FOOTPRINT, districtColor, fileOffset, heatColor, heightForLoc, layoutDistricts, neighborsFor
} from './derive.js';

const LABEL_CSS = `
.label-layer{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:3}
.scene-label{position:absolute;left:0;top:0;display:flex;align-items:center;gap:6px;white-space:nowrap;border:1px solid color-mix(in srgb,var(--label-color,#8fa8d8) 40%,transparent);border-radius:3px;background:rgba(13,20,34,.86);color:#dbe4f5;padding:5px 8px;font:500 9px/1.25 'JetBrains Mono','SFMono-Regular',Consolas,monospace;letter-spacing:.6px;pointer-events:auto;cursor:pointer;backdrop-filter:blur(6px)}
.scene-label::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--label-color,#8fa8d8)}
.scene-label:hover,.scene-label.is-selected{color:#fff;border-color:var(--label-color,#8fa8d8);background:color-mix(in srgb,var(--label-color,#8fa8d8) 22%,#0f1729)}
`;

const HIGHLIGHT = '#fff2c0';

export class CodeScene {
  constructor(container, { onSelect = () => {}, onHover = () => {} } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.labelsVisible = true;
    this.colorMode = 'district';
    this.selection = null;
    this.focusDistrict = null;
    this.disposed = false;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.hovered = null;
    this.hoverFrame = null;
    this.fileWorld = new Map();
    this.districtWorld = new Map();
    this.districtMeshes = new Map();
    this.districtLabels = [];
    this.fileLabels = [];
    this.pickSlabs = [];
    this.materials = new Set();
    this.geometries = new Set();
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

    this.style = document.createElement('style');
    this.style.textContent = LABEL_CSS;
    container.appendChild(this.style);
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'label-layer';
    container.appendChild(this.labelLayer);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x0d1524, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const canvas = this.renderer.domElement;
    canvas.style.cssText = 'display:block;position:absolute;inset:0;width:100%;height:100%;outline:none;touch-action:none;';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'SGLang 代码地图三维视图，可拖动旋转，点击街区或建筑查看依赖');
    container.insertBefore(canvas, this.labelLayer);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, .1, 600);
    this.camera.position.set(38, 46, 46);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.controls.dampingFactor = .08;
    this.controls.panSpeed = .6;
    this.controls.rotateSpeed = .55;
    this.controls.zoomSpeed = .8;
    this.controls.minPolarAngle = .12;
    this.controls.maxPolarAngle = Math.PI / 2.05;

    this.scene.add(new THREE.AmbientLight(0xf2f6ff, 1.05));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(-24, 42, 22);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9dc0ff, 1.15);
    rim.position.set(30, 26, -34);
    this.scene.add(rim);

    this.ground = new THREE.GridHelper(120, 60, 0x3d5273, 0x24324a);
    this.ground.material.transparent = true;
    this.ground.material.opacity = .26;
    this.ground.position.y = -.14;
    this.scene.add(this.ground);

    this.buildingGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.buildingGeometry.translate(0, .5, 0);
    this.geometries.add(this.buildingGeometry);
    this.slabGeometry = new THREE.BoxGeometry(1, .12, 1);
    this.geometries.add(this.slabGeometry);
    this.slabMaterial = this.track(new THREE.MeshStandardMaterial({ color: 0x1b2740, roughness: .86, metalness: .1 }));
    this.outLineMaterial = this.track(new THREE.LineBasicMaterial({ color: 0x63d3e6, transparent: true, opacity: .8 }));
    this.inLineMaterial = this.track(new THREE.LineBasicMaterial({ color: 0xd79cf0, transparent: true, opacity: .72 }));
    this.outlineMaterial = this.track(new THREE.LineBasicMaterial({ color: 0x44628c, transparent: true, opacity: .65 }));
    this.markerMaterial = this.track(new THREE.LineBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: .95 }));

    this.lineGroup = new THREE.Group();
    this.scene.add(this.lineGroup);
    this.marker = new THREE.LineSegments(new THREE.BufferGeometry(), this.markerMaterial);
    this.marker.visible = false;
    this.scene.add(this.marker);

    this.onPointerDown = event => { this.downPoint = event.button === 0 ? { x: event.clientX, y: event.clientY } : null; };
    this.onPointerUp = event => {
      const start = this.downPoint;
      this.downPoint = null;
      if (event.button !== 0 || !start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
      const hit = this.pick(event);
      if (hit) this.onSelect(hit);
    };
    this.onPointerMove = event => {
      if (this.downPoint) return;
      this.hoverPoint = { clientX: event.clientX, clientY: event.clientY };
      if (this.hoverFrame) return;
      this.hoverFrame = requestAnimationFrame(() => {
        this.hoverFrame = null;
        const at = this.hoverPoint;
        this.hoverPoint = null;
        if (this.disposed) return;
        const hit = at ? this.pick(at) : null;
        canvas.style.cursor = hit ? 'pointer' : 'grab';
        const key = hit ? `${hit.kind}:${hit.id}` : null;
        if (key !== this.hovered) { this.hovered = key; this.onHover(hit); }
      });
    };
    this.onPointerLeave = () => {
      this.hoverPoint = null;
      if (this.hoverFrame) { cancelAnimationFrame(this.hoverFrame); this.hoverFrame = null; }
      this.hovered = null;
      this.onHover(null);
      canvas.style.cursor = 'grab';
    };
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.animate();
  }

  track(resource) {
    if (resource.isMaterial) this.materials.add(resource);
    else this.geometries.add(resource);
    return resource;
  }

  material(color) {
    return this.track(new THREE.MeshStandardMaterial({ color, roughness: .58, metalness: .18 }));
  }

  build(index) {
    this.index = index;
    this.layout = layoutDistricts(index.graph.districts, index.filesById);
    this.layout.plots.forEach((plot, plotIndex) => {
      const slab = new THREE.Mesh(this.slabGeometry, this.slabMaterial);
      slab.scale.set(plot.side, 1, plot.depth);
      slab.position.set(plot.x, -.06, plot.z);
      slab.userData.pick = { kind: 'district', id: plot.id };
      this.scene.add(slab);
      this.pickSlabs.push(slab);

      const outlineGeometry = this.track(new THREE.EdgesGeometry(new THREE.BoxGeometry(plot.side, .02, plot.depth)));
      const outline = new THREE.LineSegments(outlineGeometry, this.outlineMaterial);
      outline.position.set(plot.x, .03, plot.z);
      this.scene.add(outline);

      // 一个街区一个 InstancedMesh：1,904 个文件只产生 44 次 draw call。
      const mesh = new THREE.InstancedMesh(this.buildingGeometry, this.material(districtColor(plotIndex)), plot.files.length);
      const matrix = new THREE.Matrix4();
      plot.files.forEach((fileId, i) => {
        const file = index.filesById.get(fileId);
        const { dx, dz } = fileOffset(plot, i);
        const height = heightForLoc(file.loc, index.maxLoc);
        const x = plot.x + dx, z = plot.z + dz;
        matrix.compose(
          new THREE.Vector3(x, 0, z),
          new THREE.Quaternion(),
          new THREE.Vector3(FILE_FOOTPRINT * .88, height, FILE_FOOTPRINT * .88)
        );
        mesh.setMatrixAt(i, matrix);
        mesh.setColorAt(i, new THREE.Color(this.colorFor(file, plotIndex)));
        this.fileWorld.set(fileId, { x, z, y: height, height, plotId: plot.id });
      });
      mesh.userData.plotId = plot.id;
      mesh.userData.fileIds = plot.files;
      this.scene.add(mesh);
      this.districtMeshes.set(plot.id, mesh);
      this.districtWorld.set(plot.id, { x: plot.x, z: plot.z, side: plot.side, depth: plot.depth });

      this.addDistrictLabel({ id: plot.id, text: `${plot.id} · ${plot.files.length} 文件 · ${plot.district.loc} 行`, color: districtColor(plotIndex), position: new THREE.Vector3(plot.x, .34, plot.z - plot.depth / 2 - .5), offset: [0, -18] });
    });
    this.frameAll();
    return this;
  }

  colorFor(file, plotIndex) {
    return this.colorMode === 'heat'
      ? heatColor(Math.log10(file.fanIn + 1) / Math.log10(this.index.maxFanIn + 1))
      : districtColor(plotIndex);
  }

  repaint() {
    if (!this.index) return;
    this.layout.plots.forEach((plot, plotIndex) => {
      const mesh = this.districtMeshes.get(plot.id);
      if (!mesh) return;
      plot.files.forEach((fileId, i) => {
        const selected = this.selection?.kind === 'file' && this.selection.id === fileId;
        const color = selected ? HIGHLIGHT : this.colorFor(this.index.filesById.get(fileId), plotIndex);
        mesh.setColorAt(i, new THREE.Color(color));
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
  }

  setColorMode(mode) {
    this.colorMode = mode === 'heat' ? 'heat' : 'district';
    this.repaint();
  }

  makeLabel(entry) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'scene-label';
    el.textContent = entry.text;
    el.style.setProperty('--label-color', entry.color || '#8fa8d8');
    el.addEventListener('pointerdown', event => event.stopPropagation());
    el.addEventListener('click', () => this.onSelect({ kind: entry.kind, id: entry.id }));
    this.labelLayer.appendChild(el);
    return el;
  }

  addDistrictLabel(entry) {
    this.districtLabels.push({ ...entry, kind: 'district', el: this.makeLabel(entry) });
  }

  // 文件标签只在聚焦某个街区时出现，且只给最大的若干个文件，避免上千个标签糊成一片。
  syncFileLabels() {
    for (const label of this.fileLabels) label.el.remove();
    this.fileLabels = [];
    if (!this.index) return;
    const entries = [];
    const focus = this.focusDistrict;
    if (focus) {
      const plot = this.layout.plots.find(item => item.id === focus);
      if (plot) plot.files.slice(0, 8).forEach(fileId => {
        const world = this.fileWorld.get(fileId), file = this.index.filesById.get(fileId);
        if (!world || !file) return;
        entries.push({ kind: 'file', id: fileId, text: `${fileId.split('/').pop()} · ${file.loc} 行`, color: '#9fd8ff', position: new THREE.Vector3(world.x, world.y + .1, world.z), offset: [0, -15], district: plot.id });
      });
    }
    if (this.selection?.kind === 'file') {
      const world = this.fileWorld.get(this.selection.id);
      if (world && !entries.some(entry => entry.id === this.selection.id)) {
        entries.push({ kind: 'file', id: this.selection.id, text: `${this.selection.id} · ${this.index.filesById.get(this.selection.id)?.loc ?? 0} 行`, color: HIGHLIGHT, position: new THREE.Vector3(world.x, world.y + .1, world.z), offset: [0, -15] });
      }
    }
    this.fileLabels = entries.map(entry => {
      const el = this.makeLabel(entry);
      return { ...entry, el, size: { width: el.offsetWidth, height: el.offsetHeight || 24 } };
    });
  }

  setLabels(value) {
    this.labelsVisible = !!value;
    this.updateLabels();
  }

  setSelection(selection) {
    this.selection = selection;
    if (selection?.kind === 'district') this.focusDistrict = selection.id;
    else if (selection?.kind === 'file') this.focusDistrict = this.fileWorld.get(selection.id)?.plotId || this.focusDistrict;
    this.repaint();
    this.rebuildLines();
    this.rebuildMarker();
    this.syncFileLabels();
    this.updateLabels();
  }

  setFocusDistrict(id) {
    this.focusDistrict = id;
    this.syncFileLabels();
    this.updateLabels();
  }

  rebuildLines() {
    for (const child of [...this.lineGroup.children]) {
      this.lineGroup.remove(child);
      child.geometry.dispose();
    }
    const selection = this.selection;
    if (!selection || !this.index) return;
    const isDistrict = selection.kind === 'district';
    const anchors = isDistrict ? this.districtWorld : this.fileWorld;
    const anchor = anchors.get(selection.id);
    if (!anchor) return;
    const { out, in: incoming } = neighborsFor(this.index, selection.kind, selection.id, 8);
    const build = (list, material) => {
      const positions = [];
      for (const edge of list) {
        const target = anchors.get(edge.id);
        if (!target) continue;
        if (isDistrict) positions.push(anchor.x, .35, anchor.z, target.x, .35, target.z);
        else positions.push(anchor.x, anchor.y + .1, anchor.z, target.x, target.y + .1, target.z);
      }
      if (!positions.length) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      this.lineGroup.add(new THREE.LineSegments(geometry, material));
    };
    build(out, this.outLineMaterial);
    build(incoming, this.inLineMaterial);
  }

  rebuildMarker() {
    const previous = this.marker.geometry;
    const geometry = new THREE.BufferGeometry();
    const world = this.selection?.kind === 'file' ? this.fileWorld.get(this.selection.id) : null;
    if (world) {
      const half = FILE_FOOTPRINT * .5, height = world.height + .02;
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      const positions = [];
      for (let i = 0; i < corners.length; i++) {
        const [cx, cz] = corners[i], [nx, nz] = corners[(i + 1) % corners.length];
        const px = world.x + cx * half, pz = world.z + cz * half;
        const qx = world.x + nx * half, qz = world.z + nz * half;
        positions.push(px, 0, pz, qx, 0, qz);
        positions.push(px, height, pz, qx, height, qz);
        positions.push(px, 0, pz, px, height, pz);
      }
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    }
    this.marker.geometry = this.track(geometry);
    this.marker.visible = !!world;
    previous.dispose();
  }

  frame({ kind, id } = {}) {
    if (!this.index) return;
    if (kind === 'district') {
      const world = this.districtWorld.get(id);
      if (world) {
        const radius = Math.max(world.side, world.depth) * .62;
        this.controls.target.set(world.x, 0, world.z);
        this.camera.position.set(world.x + radius, radius * 1.3, world.z + radius);
        this.frustumFor(radius);
      }
    } else if (kind === 'file') {
      const world = this.fileWorld.get(id);
      if (world) {
        const radius = 5.4;
        this.controls.target.set(world.x, world.height / 2, world.z);
        this.camera.position.set(world.x + radius, radius * 1.25, world.z + radius);
        this.frustumFor(radius);
      }
    }
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.updateLabels();
  }

  frustumFor(radius) {
    const width = this.container.clientWidth || 1, height = this.container.clientHeight || 1;
    const aspect = width / height;
    const vertical = Math.max(9, radius * 2.2 / Math.min(1, aspect));
    this.camera.left = -vertical * aspect / 2;
    this.camera.right = vertical * aspect / 2;
    this.camera.top = vertical / 2;
    this.camera.bottom = -vertical / 2;
    this.camera.updateProjectionMatrix();
  }

  frameAll() {
    const { bounds } = this.layout;
    const spanX = bounds.maxX - bounds.minX, spanZ = bounds.maxZ - bounds.minZ;
    const centerX = (bounds.minX + bounds.maxX) / 2, centerZ = (bounds.minZ + bounds.maxZ) / 2;
    const radius = Math.max(spanX, spanZ) * .62;
    this.controls.target.set(centerX, 0, centerZ);
    const span = Math.max(spanX, spanZ);
    this.camera.position.set(centerX + span * .58, span * .72, centerZ + span * .68);
    this.frustumFor(radius);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.updateLabels();
  }

  setView(view = 'iso') {
    const target = this.controls.target;
    const distance = Math.max(this.camera.top - this.camera.bottom, 14);
    const positions = {
      iso: [distance * .58, distance * .72, distance * .64],
      top: [.001, distance, .001],
      front: [0, distance * .4, distance]
    };
    const offset = positions[view] || positions.iso;
    this.camera.position.set(target.x + offset[0], target.y + offset[1], target.z + offset[2]);
    this.camera.lookAt(target);
    this.controls.update();
    this.updateLabels();
  }

  zoom(amount = 1) {
    this.camera.zoom = THREE.MathUtils.clamp(this.camera.zoom * (amount > 0 ? 1.18 : 1 / 1.18), .35, 6);
    this.camera.updateProjectionMatrix();
    this.updateLabels();
  }

  reset() {
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
    if (this.selection) this.frame(this.selection);
    else this.frameAll();
  }

  resize() {
    if (this.disposed) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const aspect = width / height;
    const vertical = (this.camera.top - this.camera.bottom) || 20;
    this.camera.left = -vertical * aspect / 2;
    this.camera.right = vertical * aspect / 2;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    for (const label of [...this.districtLabels, ...this.fileLabels]) label.size = null;
    this.updateLabels();
  }

  updateLabels() {
    if (!this.index) return;
    const width = this.container.clientWidth, height = this.container.clientHeight;
    // 两阶段：先统一写可见性，再读一次尺寸，避免逐标签读造成强制重排。
    for (const label of this.districtLabels) {
      const on = this.labelsVisible;
      label.visible = on;
      label.el.style.display = on ? 'flex' : 'none';
    }
    for (const label of this.fileLabels) {
      label.visible = true;
      label.el.style.display = 'flex';
      label.el.classList.toggle('is-selected', label.id === this.selection?.id);
      label.size ??= { width: label.el.offsetWidth, height: label.el.offsetHeight || 24 };
    }
    this.scene.updateMatrixWorld();
    const placed = [];
    const visible = [...this.districtLabels, ...this.fileLabels].filter(label => label.visible);
    for (const label of visible) {
      label.size ??= { width: label.el.offsetWidth, height: label.el.offsetHeight || 24 };
      const vector = label.position.clone().project(this.camera);
      const x = (vector.x * .5 + .5) * width + (label.offset?.[0] || 0);
      const y = (-vector.y * .5 + .5) * height + (label.offset?.[1] || 0);
      const clampedX = THREE.MathUtils.clamp(x, label.size.width / 2 + 6, Math.max(label.size.width / 2 + 6, width - label.size.width / 2 - 6));
      const clampedY = THREE.MathUtils.clamp(y, label.size.height / 2 + 6, Math.max(label.size.height / 2 + 6, height - label.size.height / 2 - 6));
      let best = { centerX: clampedX, centerY: clampedY, score: Infinity };
      for (let step = 0; step <= 6; step++) {
        for (const sign of step ? [-1, 1] : [0]) {
          const centerY = THREE.MathUtils.clamp(clampedY + sign * step * 20, label.size.height / 2 + 6, height - label.size.height / 2 - 6);
          const rect = { left: clampedX - label.size.width / 2, right: clampedX + label.size.width / 2, top: centerY - label.size.height / 2, bottom: centerY + label.size.height / 2 };
          const collisions = placed.filter(other => other.left < rect.right + 4 && other.right > rect.left - 4 && other.top < rect.bottom + 4 && other.bottom > rect.top - 4).length;
          const score = collisions * 1000 + (centerY - clampedY) ** 2;
          if (score < best.score) best = { ...rect, centerX: clampedX, centerY, score };
        }
      }
      placed.push(best);
      label.el.style.transform = `translate(${best.centerX}px,${best.centerY}px) translate(-50%,-50%)`;
      label.el.style.opacity = vector.z > 1 || vector.z < -1 ? '0' : '1';
    }
  }

  pick(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects([...this.districtMeshes.values(), ...this.pickSlabs], false);
    for (const hit of hits) {
      if (hit.object.userData?.pick) return hit.object.userData.pick;
      const fileIds = hit.object.userData?.fileIds;
      if (fileIds && Number.isInteger(hit.instanceId)) return { kind: 'file', id: fileIds[hit.instanceId] };
    }
    return null;
  }

  animate() {
    if (this.disposed) return;
    this.animationFrame = requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.updateLabels();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.animationFrame);
    if (this.hoverFrame) cancelAnimationFrame(this.hoverFrame);
    this.resizeObserver?.disconnect();
    this.controls?.dispose();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    for (const child of this.lineGroup.children) child.geometry.dispose();
    this.marker.geometry.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const mesh of this.districtMeshes.values()) mesh.dispose();
    this.renderer.dispose();
    this.labelLayer.remove();
    this.style.remove();
    canvas.remove();
  }
}
