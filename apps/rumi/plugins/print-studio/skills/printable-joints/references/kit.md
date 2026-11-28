# CAD joint kit API (`cad/rumi_joints.py`)

All lengths, radii, clearances, offsets, and positions are in **millimetres, Z up**.

| Call | Purpose |
|---|---|
| `K.start()` | Clear the scene registry and start a fresh build. Call once, first. |
| `K.register(name, shape, color=None)` | Register any custom `build123d` `Shape` (or `CadPart`) in the active scene under `name`, with optional RGB/RGBA `color` in `0..1`. |
| `K.part(name)`, `K.parts()`, `K.discard(*objs)` | Look up a registered `CadPart`, list all registered parts, or remove temporary parts from the scene. |
| `K.box(name, size, center)`, `K.box2(name, low, high)` | Solid box by `(sx, sy, sz)` and centre, or by low/high corner coordinates. |
| `K.cylinder(name, radius, length, center, axis, radius2=None)`, `K.rod(name, radius, start_point, end_point, radius2=None)` | Solid cylinder or cone frustum by centre and axis or between two points. |
| `K.sphere(name, radius, center)`, `K.prism(name, points, height, center, axis, xdir=None)`, `K.lathe(name, profile, center, axis)` | Solid sphere, extruded 2D polygon (concave allowed), or revolved `(radius, height)` profile. |
| `K.join(target, *others, keep=False)`, `K.cut(target, *tools, keep=False)`, `K.common(target, tool, keep=False)` | Exact B-Rep union, difference, and intersection. Updates `target` in place and discards tools unless `keep=True`. |
| `K.fillet(target, radius, edges=None)`, `K.chamfer(target, length, length2=None, edges=None)` | Exact B-Rep edge fillets and chamfers. |
| `K.copy(obj, name)`, `K.mirror(obj, axis, name=None, plane_origin=(0,0,0))`, `K.move(obj, offset)`, `K.rotate(obj, axis, degrees, pivot=(0,0,0))`, `K.place(obj, transform)` | Duplicate, mirror, translate, rotate, or transform a `CadPart`. |
| `K.paint(obj, rgba)` | Set whole-part surface colour `(r, g, b)`, `(r, g, b, a)` in `0..1`, or `'#rrggbb[aa]'`. |
| `K.split_faces(obj, *tools)` | Split the boundary B-Rep faces of `obj` along planes or faces while keeping it one closed solid (for crisp multi-colour seams). |
| `K.paint_faces(obj, faces, rgba)` | Paint specific B-Rep faces on `obj` (`Face`, iterable of `Face`s, or predicate `fn(face) -> bool`) as USD `GeomSubset` multi-colour materials. |
| `K.paint_regions(obj, painter)` | Attach a per-triangle region painter `painter(centroids_mm, normals)` returning `(T, 3)`/`(T, 4)` RGBA in `0..1` (`NaN` rows preserve existing colour) or a length-`T` sequence. |
| `K.bounds(obj)`, `K.volume(obj)`, `K.solids(obj)`, `K.distance(a, b)`, `K.require_one_solid(obj, recipe, hint)` | Bounding box corners, volume in mm³, disconnected solid count, exact B-Rep minimum distance (`BRepExtrema`), and single-solid assertion. |
| `K.direction(value)`, `K.frame(pivot, axis, xdir=None)`, `K.outline_distances(points, outlines)` | Unit direction vectors, orthonormal local frames, and fast NumPy 2D outline distances. |
| `K.joint(name, kind, parent, child, axis='Z', pivot=(0,0,0), limits=(0,0), control=None, retainer=None)` | Declare a custom joint (`kind`: `'fixed'`, `'revolute'`, `'prismatic'`; optional `retainer` on fixed joints: `'rigid'`, `'bayonet'`, `'threaded'`, `'snap'`, `'friction'`). |
| `K.step_translate(part, delta_or_path)` | Declare a rigid linear disassembly move (`[dx, dy, dz]` in mm, or a path of offsets). |
| `K.step_twist(part, pivot, axis, degrees, pull=None, pitch_mm=0.0)` | Declare a twist-unlock (`bayonet`) or helical unscrew (`pitch_mm != 0`) disassembly step with optional final pull-out translation. |
| `K.step_snap(part, snap_delta, max_interference_mm=1.4, pull=None, mate=None)` | Declare a bounded elastic snap disengagement step (`0 < max_interference_mm <= 2.5`) with optional pull-out and explicit mating part name. |
| `K.publish(directory, parts=None, root=None, joints=(), mode='separate', sequences=(), steps=None, controls=None, check=True)` | Auto-collects registered parts, recipe joints, topologically ordered disassembly `actions`, and badge features; publishes `model.step`, `parts/*.brep`, `model.usda`, and prints `RUMI_MODEL` + `RUMI_CHECKS`. |

Axes accept `'X'`, `'-Y'`, `'+Z'`, or any 3D vector. Give temporary helper solids names starting with `_` or call `K.discard(...)` so only real printable parts are published. Every recipe returns a `RecipeResult` with `.parts`, `.joints`, `.steps`, and `.features` (which also unpacks/iterates cleanly as joint records when passed to `K.publish`).
