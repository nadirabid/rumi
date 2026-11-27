# Blender joint kit API

| Call | Makes |
|---|---|
| `K.start()` | An empty metric scene. Call once, first. |
| `K.box(name, size, center)`, `K.box2(name, low, high)` | A box by size and centre, or by two corners. |
| `K.cylinder(name, radius, length, center, axis, radius2=None)`, `K.rod(name, radius, a, b)` | A cylinder or cone frustum, by centre and axis or between two points. |
| `K.sphere(name, radius, center)`, `K.prism(name, points, height, center, axis)`, `K.lathe(name, profile, center, axis)` | A sphere, an extruded 2D outline (concave is fine), a revolved `(radius, height)` profile. |
| `K.join(a, b, ...)`, `K.cut(a, tool, ...)`, `K.common(a, tool)` | Fuse, subtract, intersect. The first part is changed and kept; the others are deleted. Results are cleaned for the geometry check. |
| `K.copy(obj, name)`, `K.mirror(obj, 'X', name)`, `K.move(obj, offset)`, `K.rotate(obj, axis, degrees, pivot)` | Duplicate, mirror across the origin plane, translate, turn. |
| `K.paint(obj, (r, g, b))` | One surface colour. |
| `K.bounds(obj)`, `K.solids(obj)` | Corner coordinates; the number of disconnected pieces (a printable part has one). |
| `K.joint(name, kind, parent, child, axis, pivot, limits, control)` | A joint record for a connector you modelled yourself. |
| `K.publish(directory, root, joints, mode=..., controls=...)` | Publishes `model.usda`, writes the whole USD assembly from the joint records, and prints `RUMI_CHECKS`. It replaces `helper["publish"]` and `configure_robot`. |

Axes are `'X'`, `'-Y'`, `'+Z'` or a vector. Give tools and helper solids names starting with `_`; never leave one in the scene, because every visible mesh is published as a part. Overlap pieces you fuse by at least 0.5 mm and run cutters past the surface.
