"""Snap, peg, key, thread, insert and magnet recipes. Kit names (cylinder, cut, join, frame, place, joint, ...) are injected by rumi_joints.

Every recipe works in a local frame (Z along `axis`, origin at `pivot`) and places the finished features with `place`.
"""
import math

import bmesh
import bpy
from mathutils import Matrix, Vector


def _check_axes(recipe, axis, other, other_name):
    if abs(direction(axis).dot(direction(other))) > 1e-3:
        raise ValueError('%s: %s must be perpendicular to axis' % (recipe, other_name))


def _points(points):
    """Accept one (x, y, z) point or a list of them."""
    if len(points) and not hasattr(points[0], '__len__'):
        return [tuple(points)]
    return [tuple(p) for p in points]


def _extent(obj, pivot, axis):
    """Distance in mm from `pivot` to the part's far side measured along `axis`."""
    along, origin = direction(axis), Vector(pivot)
    return max((vertex.co * 1000 - origin).dot(along) for vertex in obj.data.vertices)


def _triangulated(*objects):
    """Triangulate here, and collapse needle faces, so the exporter and the validator's 0.001 mm weld find no slivers or warped n-gons."""
    for obj in objects:
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.triangulate(bm, faces=[face for face in bm.faces if len(face.verts) > 3])
        for _ in range(4):
            needles = [face for face in bm.faces if face.calc_area() < 4e-12]
            edges = {min(face.edges, key=lambda edge: edge.calc_length()) for face in needles}
            if not edges:
                break
            bmesh.ops.collapse(bm, edges=list(edges))
            bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-9)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(obj.data)
        bm.free()


def _funnel(name, low, high, face, inward, leads):
    """Rectangular lead-in cutter for a window whose corners are `low` and `high` (local x, y) in the plane z = face.

    inward is +1 or -1, the z direction the window runs into the part. leads gives the 45 degree chamfer on each side
    (x low, x high, y low, y high); a side with 0 is left square.
    """
    depth = max(leads)

    def rectangle(z, outer):
        margins = [(lead + 0.5 if outer else max(lead - depth, 0)) if lead else -0.3 for lead in leads]
        x0, x1 = low[0] - margins[0], high[0] + margins[1]
        y0, y1 = low[1] - margins[2], high[1] + margins[3]
        return [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)]

    bm = bmesh.new()
    outer = [bm.verts.new(point) for point in rectangle(face - inward * 0.5, True)]
    inner = [bm.verts.new(point) for point in rectangle(face + inward * depth, False)]
    bm.faces.new(outer[::-1])
    bm.faces.new(inner)
    for i in range(4):
        bm.faces.new((outer[i], outer[(i + 1) % 4], inner[(i + 1) % 4], inner[i]))
    bmesh.ops.transform(bm, matrix=Matrix.Scale(0.001, 4), verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


# ------------------------------------------------------------------ snap hook

def snap_hook(parent, child, pivot, axis, hook_side, width=8, wall=3, arm_thickness=2, hook_height=1.5, standoff=9,
              clearance=0.3, play=0.2, lead_in=0.8, name=None):
    """Cantilever snap hook on `child` that clicks through a window cut in `parent`'s wall; the hook locks behind the wall.

    pivot: centre of the window on the wall face the child approaches from. axis: insertion direction, through the wall.
    hook_side: direction the hook bump points (the arm flexes the opposite way while it passes the window).
    wall: wall thickness along axis. width: arm width. arm_thickness: arm thickness (flex direction).
    hook_height: how far the hook stands proud of the arm; must exceed `clearance`.
    standoff: gap along axis from the wall face back to the child's face the arm grows from; the child must reach
    from there 3 mm further back and cover about 14 mm across the arm width and 12 mm across its thickness.
    clearance: window gap around the arm. play: gap between wall faces and the stop and hook shoulders.
    lead_in: 45 degree chamfer round the window on the approach face; it also keeps the physics check from reading
    the window rim as a penetration.
    Fixed joint: seated, the hook behind the wall and the shoulders in front of it hold the child in every direction.
    """
    _check_axes('snap_hook', axis, hook_side, 'hook_side')
    t, h, c = arm_thickness, hook_height, clearance
    if h <= c + 0.3 or t < 1.2 or width < 4 or standoff < 6 or wall < 1.5:
        raise ValueError('snap_hook: need hook_height > clearance + 0.3, arm_thickness >= 1.2, width >= 4, standoff >= 6, wall >= 1.5')
    back = standoff + 3                      # arm and tongue root, embedded 3 mm in the child
    ret = wall + play                        # hook return face, just behind the wall
    tip = ret + 0.5 + h / math.tan(math.radians(30))
    root = t / 2 + 0.8 * t
    outline = [(-t / 2, -back), (-t / 2, tip), (t / 2, tip), (t / 2 + h, ret + 0.5), (t / 2 + h, ret), (t / 2, ret),
               (t / 2, -(standoff - 6)), (root, -(standoff + 1)), (root, -back)]
    arm = prism('_arm', outline, width, (0, 0, 0), '-Y', 'X')
    flex = 1.5                               # free space under the arm for the hook to be pushed down
    floor_top = -t / 2 - h
    tongue = box2('_tongue', (floor_top - flex, -width / 2, -back), (floor_top, width / 2, wall - play))
    near, far = width / 2 + c + 0.4, width / 2 + c + 6.2
    shoulders = [box2('_shoulder', (-6, low, -back), (6, high, -play)) for low, high in ((near, far), (-far, -near))]
    window = box2('_window', (floor_top - flex - c, -width / 2 - c, -2), (t / 2 + c, width / 2 + c, wall + 2))
    world = frame(pivot, axis, hook_side)
    cut(parent, place(window, world))
    if lead_in:
        low, high = (floor_top - flex - c, -width / 2 - c), (t / 2 + c, width / 2 + c)
        cut(parent, place(_funnel('_lead', low, high, 0, 1, (lead_in,) * 4), world),
            place(_funnel('_lead_back', low, high, wall, -1, (lead_in, 0, lead_in, lead_in)), world))
    join(child, place(arm, world), place(tongue, world), *[place(s, world) for s in shoulders])
    require_one_solid(child, 'snap_hook', 'Bring the child to standoff mm behind the wall face and make it wider than the arm and shoulders.')
    require_one_solid(parent, 'snap_hook', 'The window must sit inside the wall, not cut it in two.')
    _triangulated(parent, child)
    return joint(name or child.name + 'Snap', 'fixed', parent, child)


# ------------------------------------------------------------------ snap lid

def _meet(first, second):
    (px, pz), (dx, dz) = first
    (qx, qz), (ex, ez) = second
    det = dx * ez - dz * ex
    s = ((qx - px) * ez - (qz - pz) * ex) / det
    return (px + s * dx, pz + s * dz)


def _at_radius(line, radius):
    (px, pz), (dx, dz) = line
    s = (radius - px) / dx
    return (radius, pz + s * dz)


def _offset_line(start, end, distance):
    """Line through start->end shifted to its right by `distance`; points are (radius, height)."""
    dx, dz = end[0] - start[0], end[1] - start[1]
    length = math.hypot(dx, dz)
    dx, dz = dx / length, dz / length
    return ((start[0] + dz * distance, start[1] - dx * distance), (dx, dz))


def snap_lid(parent, child, pivot, axis, radius, bead=0.8, bead_depth=3.8, skirt_wall=2.2, skirt_depth=None,
             clearance=0.3, seat=0.15, gap=0.3, keys=2, key_width=3, xdir=None, name=None):
    """Round snap-on lid: a bead around a round container, a skirt with a matching groove added to the lid.

    pivot: centre of the container's rim plane. axis: out of the container mouth. radius: outer radius of the container
    wall at the rim (a plain cylinder at least 1.4 mm thick). child: a plate (any outline wider than
    radius + clearance + skirt_wall, at least 1.5 mm thick) whose underside is `gap` mm above the rim; the recipe adds the skirt.
    bead: radial height of the bead (0.5-1.0; flexing the skirt over it needs a flexible material). bead_depth: rim to
    the top of the bead. clearance: radial gap between skirt and container. seat: groove oversize around the bead.
    keys: number of 1 mm anti-spin ribs on the container, each in a slot in the skirt (0 = lid may spin freely;
    needs a skirt_wall of at least 2.2). key_width: rib width. xdir: direction of the first key.
    Fixed joint: the groove's lower flank locks under the bead; the lid rests on the bead flank and lid plate.
    """
    if not 0.4 <= bead <= 1.2 or radius < 8 or skirt_wall < 1.5:
        raise ValueError('snap_lid: bead must be 0.4-1.2 mm, radius at least 8 mm, skirt_wall at least 1.5 mm')
    span = 2.75 * bead + 0.4                 # lower flank 45 degrees, 0.4 flat, upper flank about 30 degrees
    bottom = -bead_depth - span
    depth = skirt_depth if skirt_depth is not None else bead_depth + span + 1.2
    if depth < bead_depth + span + 0.8:
        raise ValueError('snap_lid: skirt_depth must reach at least 0.8 mm below the bead')
    world = frame(pivot, axis)

    ring = lathe('_bead', [(radius - 0.5, bottom), (radius, bottom), (radius + bead, bottom + bead),
                           (radius + bead, bottom + bead + 0.4), (radius, -bead_depth), (radius - 0.5, -bead_depth)], segments=96)
    join(parent, place(ring, world))

    low = (radius, bottom), (radius + bead, bottom + bead)
    flat = (radius + bead, bottom + bead), (radius + bead, bottom + bead + 0.4)
    high = (radius + bead, bottom + bead + 0.4), (radius, -bead_depth)
    lines = [_offset_line(a, b, seat) for a, b in (low, flat, high)]
    groove_shape = [_at_radius(lines[0], radius), _meet(lines[0], lines[1]), _meet(lines[1], lines[2]), _at_radius(lines[2], radius)]

    inner = radius + clearance
    skirt = lathe('_skirt', [(inner, -depth), (inner + skirt_wall, -depth), (inner + skirt_wall, gap + 1.2), (inner, gap + 1.2)], segments=96)
    join(child, place(skirt, world))
    cut(child, place(lathe('_groove', groove_shape, segments=96), world))
    for index in range(keys):
        angle = 360 * index / keys
        rib = rotate(box2('_key', (radius - 0.5, -key_width / 2, bottom - 0.6), (radius + 1.0, key_width / 2, -0.6)), 'Z', angle)
        join(parent, place(rib, world))
        notch = rotate(box2('_notch', (radius, -key_width / 2 - 0.3, -depth - 1), (radius + 1.4, key_width / 2 + 0.3, -0.2)), 'Z', angle)
        cut(child, place(notch, world))
    require_one_solid(parent, 'snap_lid', 'The container wall must be a cylinder of the given radius at the bead, at least 1.4 mm thick.')
    require_one_solid(child, 'snap_lid', 'Make the lid plate at least 1.5 mm thick with its underside gap mm above the rim and wider than the skirt.')
    _triangulated(parent, child)
    return joint(name or child.name + 'Snap', 'fixed', parent, child)


# ------------------------------------------------------------------ press pegs

def press_pegs(parent, child, points, axis, diameter=5, length=8, clearance=0.1, chamfer=0.6, hole_depth=None,
               gap=0.2, pegs_on='parent', name=None):
    """Round pegs on one part pressed into blind holes in the other.

    points: where the pegs stand, on the peg part's face (one (x, y, z) or a list).
    axis: from the parent toward the child. pegs_on: 'parent' (holes in child) or 'child' (holes in parent).
    diameter: peg diameter (3-10). length: peg length. clearance: radial gap in the hole (0.05-0.2; FDM press fits need tuning).
    hole_depth: default length + 1; the holes must not break through the far side of the part.
    gap: the other part's face sits this far from the peg part's face; faces that touch fail the geometry check.
    Fixed joint, but only friction holds it: validation reports `unretained_part`.
    """
    if pegs_on not in ('parent', 'child'):
        raise ValueError("press_pegs: pegs_on must be 'parent' or 'child'")
    if diameter < 3 or chamfer >= diameter / 2 - 0.5 or length < 2:
        raise ValueError('press_pegs: need diameter >= 3, length >= 2 and a chamfer under half the radius')
    outward = direction(axis) if pegs_on == 'parent' else -direction(axis)
    pegged, holed = (parent, child) if pegs_on == 'parent' else (child, parent)
    depth = hole_depth if hole_depth is not None else length + 1
    radius = diameter / 2
    for jitter in _tries('press_pegs', parent, child):
        for point in _points(points):
            world = frame(point, outward)
            peg = rotate(lathe('_peg', [(0, -1.5), (radius, -1.5), (radius, length - chamfer), (radius - chamfer, length), (0, length)]), 'Z', jitter)
            join(pegged, place(peg, world))
            hole = rotate(cylinder('_hole', radius + clearance, depth + 1, (0, 0, gap + (depth - 1) / 2)), 'Z', jitter)
            cut(holed, place(hole, world))
        require_one_solid(pegged, 'press_pegs', 'Put each point on the face of the peg part so the peg is embedded in it.')
        _triangulated(parent, child)
    return joint(name or child.name + 'Pegs', 'fixed', parent, child)


# ------------------------------------------------------------------ dog-bone key

def dogbone_key(parent, child, pivot, axis, lift, length=18, bulb_diameter=11, neck_width=5, height=4.5,
                clearance=0.3, recess=0.3, closed=False, skin=1.2, name=None):
    """Separate dog-bone key across the seam between two plates: a pocket in each plate holds one bulb of the key.

    pivot: centre of the key on the seam, on the face the pockets open from. axis: across the seam from parent to child.
    lift: the direction out of that face (the key drops in against it). The plates must reach length/2 + clearance
    + 1 from the pivot on their own side and be thick enough for the pocket (height + clearance + 1.2 mm floor).
    length: tip to tip. height: key thickness. recess: key top below the face (open key).
    closed=False (default): open pockets, the key drops in and can lift out: it stays loose without glue.
    closed=True: pockets are sealed cavities `skin` mm under both faces; print the key inside (print-in-place),
    plates at least 2 * skin + height + 2 * clearance thick. The key can then not escape.
    Returns [seam joint, key joint]; the key is a new part named `name` (default 'DogboneKey').
    """
    _check_axes('dogbone_key', axis, lift, 'lift')
    if neck_width + 2 > bulb_diameter or length < bulb_diameter * 1.4 or height < 2:
        raise ValueError('dogbone_key: bulb_diameter must exceed neck_width by 2 mm, length be at least 1.4 x bulb_diameter, height at least 2')
    offset = (length - bulb_diameter) / 2
    top = -(skin + clearance) if closed else -recess
    bottom = top - height
    floor, roof = bottom - clearance, (-skin if closed else 1)
    world = frame(pivot, lift, axis)
    key_name = name or 'DogboneKey'

    def shape(grow, z0, z1):
        pad = grow
        bulbs = [cylinder('_bulb', bulb_diameter / 2 + pad, z1 - z0, (sign * offset, 0, (z0 + z1) / 2), segments=128) for sign in (1, -1)]
        neck = box2('_neck', (-offset, -neck_width / 2 - pad, z0), (offset, neck_width / 2 + pad, z1))
        return join(neck, *bulbs)

    pocket = place(shape(clearance, floor, roof), world)
    cut(parent, pocket, keep=True)
    cut(child, pocket)
    key = place(shape(0, bottom, top), world)
    key.name = key_name
    key.data.name = key_name
    require_one_solid(parent, 'dogbone_key', 'The pocket must not split the plate; make it thicker or the pocket shallower.')
    require_one_solid(child, 'dogbone_key', 'The pocket must not split the plate; make it thicker or the pocket shallower.')
    _triangulated(parent, child, key)
    return [joint(key_name + 'Seam', 'fixed', parent, child), joint(key_name + 'Joint', 'fixed', parent, key)]


# ------------------------------------------------------------------ tab and slot

def tab_slot(parent, child, pivot, axis, across, tabs=(-12, 12), tab_width=10, tab_thickness=3, plate=4, barb=0.6,
             clearance=0.2, play=0.2, relief=0, gap=0.2, lead_in=0.8, name=None):
    """Split barbed tabs on `child` snap through slots in `parent`'s plate and catch its underside.

    pivot: point on the plate's top face the tabs are measured from. axis: from the plate toward the child. across: the
    direction along the child's foot, the way tab_width is measured; tabs sit at the offsets in `tabs` (mm) along it.
    plate: the parent plate's thickness at the slots; its far face must be a flat plane. The child's foot is a flat face
    `gap` above the plate's top face (touching faces fail the geometry check) and the child must be solid for 1.5 mm + relief above it across each tab.
    tab_thickness: through the slot, perpendicular to across. barb: catch height. clearance: slot gap per side.
    relief: depth of an extra slot into the child so the prongs flex over more length (0 = stiff; 4+ for PETG).
    lead_in: 45 degree chamfer round each slot on the top face; it also keeps the physics check from reading the slot rim as a penetration.
    Fixed joint: the barbs catch under the plate, the foot rests on the plate, the tabs sit in the slots.
    """
    _check_axes('tab_slot', axis, across, 'across')
    slit = 2 * (barb + clearance) + 0.4
    if tab_width < slit + 4 or tab_thickness < 1.5 or plate < 1.2 or barb < 0.3:
        raise ValueError('tab_slot: tab_width must be at least %.1f mm for this barb, tab_thickness >= 1.5, plate >= 1.2, barb >= 0.3' % (slit + 4))
    half = tab_width / 2
    catch = -(plate + play)
    end = catch - 2.0
    top = gap + relief + 1.5
    world = frame(pivot, axis, across)
    for x in tabs:
        low = (x - half - clearance, -tab_thickness / 2 - clearance)
        high = (x + half + clearance, tab_thickness / 2 + clearance)
        if relief:
            cut(child, place(box2('_relief', (*low, gap - 1), (*high, gap + relief)), world))
        for sign in (1, -1):
            outline = [(sign * u, v) for u, v in [(slit / 2, top), (half, top), (half, catch), (half + barb, catch),
                                                   (slit / 2 + 0.4, end), (slit / 2, end)]]
            join(child, place(prism('_prong', outline, tab_thickness, (x, 0, 0), '-Y', 'X'), world))
        cut(parent, place(box2('_slot', (*low, -plate - 2), (*high, 1)), world))
        if lead_in:
            cut(parent, place(_funnel('_lead', low, high, 0, -1, (lead_in,) * 4), world),
                place(_funnel('_lead_back', low, high, -plate, 1, (0, 0, lead_in, lead_in)), world))
    require_one_solid(child, 'tab_slot', 'The child must be solid for 1.5 mm above the plate face across every tab.')
    require_one_solid(parent, 'tab_slot', 'The slots must leave the plate in one piece; move the tabs apart or away from the edge.')
    _triangulated(parent, child)
    return joint(name or child.name + 'Tabs', 'fixed', parent, child)


# ------------------------------------------------------------------ bayonet lock

def _sector(inner, outer, start, end, low, high):
    """Annular sector prism between two angles in degrees; arc points sit on whole degrees so overlapping sectors share vertices."""
    low_angle, high_angle = min(start, end), max(start, end)
    inside = [g for g in range(int(math.floor(low_angle)), int(math.ceil(high_angle)) + 1) if low_angle + 0.25 < g < high_angle - 0.25]
    angles = [math.radians(a) for a in [low_angle] + inside + [high_angle]]
    ring = [(outer * math.cos(a), outer * math.sin(a)) for a in angles] + [(inner * math.cos(a), inner * math.sin(a)) for a in reversed(angles)]
    return prism('_sector', ring, high - low, (0, 0, (low + high) / 2))


def bayonet_lock(parent, child, pivot, axis, bore_diameter=20, lugs=3, lug_reach=2.5, lug_thickness=3, lug_angle=24,
                 turn=40, lip=4, depth=16, notch=0.8, clearance=0.3, gap=1.2, lead_in=0.8, start_angle=90, xdir=None,
                 name=None):
    """Twist-lock plug: a stem with radial lugs on `child` locks under a lip in L-shaped slots cut into `parent`. Modelled locked.

    pivot: centre of the parent's mouth. axis: out of the mouth. The parent needs a solid block around the mouth,
    radius bore_diameter/2 + lug_reach + clearance + 2 mm, `depth` deep. child: a cap whose underside is `gap` mm above
    the parent face and wider than the stem; the recipe adds the stem and lugs. gap must be at least notch + 0.3.
    bore_diameter: socket bore. lugs: 2-4. lug_reach: how far the lugs stand out of the stem. lip: wall above the lug channel.
    turn: degrees from the entry slot to the locked pose, counter-clockwise about axis seen from the front; negative turns the other way.
    start_angle / xdir: where the first locked lug sits (degrees from xdir).
    notch: depth of a pocket in the channel floor at each locked position. The lugs sit in it, which stops the twist
    back to the entry; lift the cap by `notch` to unlock. notch=0 leaves the twist unstopped, and validation then
    reports `unretained_part`. lead_in: chamfer on the channel floor's inner edge (keeps the physics check from reading
    the rim as a penetration).
    Declared fixed in the locked pose.
    """
    if lugs not in (2, 3, 4):
        raise ValueError('bayonet_lock: lugs must be 2, 3 or 4')
    pad = 2.0
    half = lug_angle / 2 + pad
    if abs(turn) < lug_angle + 2 * pad + 4 or (lug_angle + 2 * pad + 10) * lugs > 360:
        raise ValueError('bayonet_lock: turn must exceed lug_angle + 8 degrees and the lugs must fit round the stem')
    height = lug_thickness + 2 * clearance
    if depth < lip + height + 4 + notch:
        raise ValueError('bayonet_lock: depth must be at least lip + lug_thickness + 4.6 mm + notch')
    if gap < notch + 0.3:
        raise ValueError('bayonet_lock: gap must be at least notch + 0.3 mm so the cap can drop into the notch')
    bore, stem = bore_diameter / 2, bore_diameter / 2 - clearance
    lug_radius = bore + lug_reach
    slot_radius = lug_radius + clearance
    floor = -lip - height
    low_lug = floor + clearance - notch           # lug underside: lowered into the notch
    world = frame(pivot, axis, xdir)

    def chamfer(level, start, end):
        """Chamfer the inner edge of a floor at `level` between two angles so the lug does not rest across a sharp rim."""
        ring = lathe('_chamfer', [(bore - 0.5, level + 0.5), (bore + lead_in + 0.5, level + 0.5), (bore - 0.5, level - lead_in - 0.5)], segments=90)
        wedge = _sector(bore - 1.5, bore + lead_in + 1, start, end, level - lead_in - 1, level + 1)
        cut(parent, place(common(ring, wedge), world))

    for jitter in _tries('bayonet_lock', parent, child):
        # Rotated off the whole-degree slot planes so no cylinder edge sits exactly on a cutter plane.
        cut(parent, place(rotate(cylinder('_bore', bore, depth + 1, (0, 0, -depth / 2 + 0.5), segments=90), 'Z', 0.37 + jitter), world))
        stem_part = rotate(cylinder('_stem', stem, depth - 2 + gap + 1.5, (0, 0, (-(depth - 2) + gap + 1.5) / 2), segments=90), 'Z', 0.37 + jitter)
        join(child, place(stem_part, world))
        for index in range(lugs):
            locked = start_angle + 360 * index / lugs
            entry = locked - turn
            # Entry shaft and channel only touch along one plane, so the exact solver never meets overlapping coincident walls.
            beyond = (entry + half, locked + half) if turn > 0 else (locked - half, entry - half)
            slot = _sector(bore - 1, slot_radius, entry - half, entry + half, floor, 1)
            join(slot, _sector(bore - 1, slot_radius, beyond[0], beyond[1], floor, floor + height))
            cut(parent, place(slot, world))
            if lead_in:
                chamfer(floor, min(entry, locked) - half, max(entry, locked) + half)
            if notch:
                side = lug_angle / 2 + 3.0
                cut(parent, place(_sector(bore - 1, lug_radius + 0.2, locked - side, locked + side, floor - notch, floor + 0.5), world))
                if lead_in:
                    chamfer(floor - notch, locked - side, locked + side)
            lug = _sector(stem - 1, lug_radius, locked - lug_angle / 2, locked + lug_angle / 2, low_lug, low_lug + lug_thickness)
            join(child, place(lug, world))
        require_one_solid(child, 'bayonet_lock', 'Put the cap underside gap mm above the socket face and make it wider than the stem.')
        require_one_solid(parent, 'bayonet_lock', 'Leave solid wall round the bore: the slots must not split the socket.')
        _triangulated(parent, child)
    return joint(name or child.name + 'Bayonet', 'fixed', parent, child)


# ------------------------------------------------------------------ printed bolt and nut

_THREAD_STEPS = 48
_THREAD_PHASES = (0.0137, 0.0059, 0.0101, 0.0173, 0.0029, 0.0151, 0.0083, 0.0197)   # helix starts, in turns, tried in order


def _sound(mesh):
    """True when the mesh, after the validator's 0.001 mm weld, has no open edges, needle faces or crossing faces."""
    from mathutils.bvhtree import BVHTree
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.transform(bm, matrix=Matrix.Scale(1000, 4), verts=bm.verts)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.001)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.faces.ensure_lookup_table()
    tree = BVHTree.FromBMesh(bm, epsilon=0.00001)
    sound = (all(edge.is_manifold for edge in bm.edges) and all(face.calc_area() > 1e-6 for face in bm.faces)
             and all(set(bm.faces[a].verts) & set(bm.faces[b].verts) for a, b in tree.overlap(tree) if a < b))
    bm.free()
    return sound


def _tries(recipe, *parts):
    """Yield turn angles for the round cutters; when a try leaves an open or crossing mesh, restore the parts and yield the next."""
    saved = {obj: obj.data.copy() for obj in parts}
    checked = [obj for obj in parts if _sound(saved[obj])]     # parts that were already unsound are not blamed on the recipe
    for jitter in (0.0, 0.37, 0.71, 1.13, 1.57, 2.03):
        yield jitter
        if all(_sound(obj.data) for obj in checked):
            for copy_ in saved.values():
                bpy.data.meshes.remove(copy_)
            return
        for obj in parts:
            broken = obj.data
            obj.data = saved[obj].copy()
            bpy.data.meshes.remove(broken)
    for copy_ in saved.values():
        bpy.data.meshes.remove(copy_)
    raise ValueError('%s: the booleans left open or crossing faces on every attempt; move the feature by 0.5 mm and try again' % recipe)


def _sweep(name, profile, pitch, z_from, z_to, phase):
    """Sweep a closed (radius, dz) profile along a right-handed helix of the given pitch about Z, covering z in [z_from, z_to].

    phase is the start offset of the helix in turns; the bolt and the nut must share it.
    """
    first = int(math.floor(z_from / pitch * _THREAD_STEPS))
    last = int(math.ceil(z_to / pitch * _THREAD_STEPS))
    bm = bmesh.new()
    rings = []
    for step in range(first, last + 1):
        turns = step / _THREAD_STEPS + phase
        angle = 2 * math.pi * turns
        rise = pitch * turns
        rings.append([bm.verts.new((r * math.cos(angle), r * math.sin(angle), rise + dz)) for r, dz in profile])
    count = len(profile)
    for ring, following in zip(rings, rings[1:]):
        for i in range(count):
            bm.faces.new((ring[i], ring[(i + 1) % count], following[(i + 1) % count], following[i]))
    bm.faces.new(rings[0][::-1])
    bm.faces.new(rings[-1])
    bmesh.ops.triangulate(bm, faces=list(bm.faces))
    bmesh.ops.transform(bm, matrix=Matrix.Scale(0.001, 4), verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def bolt_nut(parent, child, pivot, axis, diameter=12, pitch=2, length=24, seat=2, clearance=0.3, name=None):
    """Real helical thread: a bolt stud grows from `parent`'s face and a matching thread is cut through `child`, the nut.

    pivot: centre of the stud on the parent's face. axis: out of the face. diameter: nominal (8-30). pitch: 2-4 (finer threads need a smaller flank clearance than this recipe allows).
    length: stud length from the face. seat: where the child's near face sits along the stud (at least 0.2). The child must
    be solid around the stud from seat upward (a hex nut or cap, wider than the thread) and its near face flat at seat.
    clearance: radial and flank gap (0.2-0.4). The thread is right-handed, 60 degree flanks, 48 steps per turn.
    Fixed joint: the nut is held on the stud by the flanks along the axis but can still unscrew; validation reports
    `unretained_part` for the spin about the axis. Print the stud axis vertical, with 0.1-0.15 mm layers.
    The thread booleans are checked in place and retried with another helix start when they leave bad geometry.
    """
    if not 8 <= diameter <= 30 or not 2 <= pitch <= 4 or diameter / pitch < 3:
        raise ValueError('bolt_nut: diameter must be 8-30 mm, pitch 2-4 mm and diameter at least 3 x pitch')
    if length - seat < 2 * pitch or seat < 0.2:
        raise ValueError('bolt_nut: seat must be at least 0.2 mm (touching faces fail the geometry check) and length at least seat + 2 x pitch')
    tan = math.tan(math.radians(30))
    crest, crest_flat = diameter / 2 - 0.15, 0.175 * pitch
    root = crest - 0.425 * pitch
    if root < 3:
        raise ValueError('bolt_nut: the thread core would be under 6 mm; use a larger diameter')
    flank = clearance / math.cos(math.radians(30))
    nut_crest, nut_root = root + clearance, crest + clearance
    embed = 0.08

    def ridge_width(r):
        return crest_flat + 2 * tan * (crest - r)

    stud_profile = [(root - embed, -(ridge_width(root) / 2 + tan * embed)), (crest, -crest_flat / 2),
                    (crest, crest_flat / 2), (root - embed, ridge_width(root) / 2 + tan * embed)]
    valley_profile = [(nut_crest - embed, -(ridge_width(nut_crest) / 2 + flank + tan * embed)), (nut_root, -(ridge_width(nut_root) / 2 + flank)),
                      (nut_root, ridge_width(nut_root) / 2 + flank), (nut_crest - embed, ridge_width(nut_crest) / 2 + flank + tan * embed)]

    world = frame(pivot, axis)
    top = length + 1
    saved = {obj: obj.data.copy() for obj in (parent, child)}
    checked = [obj for obj in (parent, child) if _sound(saved[obj])]     # parts that were already unsound are not blamed on the thread
    for phase in _THREAD_PHASES:
        ridge = _sweep('_ridge', stud_profile, pitch, -pitch, length + pitch, phase)
        core = rotate(cylinder('_core', root, length + 2, (0, 0, (length - 1) / 2), segments=96), 'Z', 0.9)
        join(core, ridge)
        common(core, rotate(cylinder('_env', crest + 0.4, length + 1, (0, 0, (length - 1) / 2), segments=96), 'Z', 1.1))
        join(parent, place(core, world))
        hole = rotate(cylinder('_hole', nut_crest, top + 0.5 - seat + 1.6, (0, 0, (seat - 1.6 + top + 0.5) / 2), segments=96), 'Z', 0.9)
        cut(child, place(hole, world))
        cut(child, place(_sweep('_valley', valley_profile, pitch, seat - 1.3 - pitch, top, phase), world))
        _triangulated(parent, child)
        if all(_sound(obj.data) for obj in checked):
            break
        for obj in (parent, child):         # this helix start left a bad boolean: restore and try the next one
            broken = obj.data
            obj.data = saved[obj].copy()
            bpy.data.meshes.remove(broken)
    else:
        raise ValueError('bolt_nut: the thread booleans failed for every helix start; change length or seat by 0.3 mm or more')
    for copy_ in saved.values():
        bpy.data.meshes.remove(copy_)
    require_one_solid(parent, 'bolt_nut', 'Put the pivot on the parent face with at least 1 mm of material under it.')
    require_one_solid(child, 'bolt_nut', 'The thread must not split the child; make the nut wider than the thread.')
    return joint(name or child.name + 'Thread', 'fixed', parent, child)


# ------------------------------------------------------------------ heat-set insert and screw

_SCREWS = {'M2': (2.0, 3.8, 2.0, 3.2, 4.0), 'M2.5': (2.5, 4.5, 2.5, 3.6, 5.0), 'M3': (3.0, 5.5, 3.0, 4.6, 5.7),
           'M4': (4.0, 7.0, 4.0, 5.6, 8.1), 'M5': (5.0, 8.5, 5.0, 6.4, 9.5)}


def insert_boss(parent, child, points, axis, screw='M3', insert_diameter=None, insert_length=None, melt=0.4, relief=0.6,
                thickness=None, name=None):
    """Pocket for a brass heat-set insert in `parent` and a clearance hole with counterbore in `child`; no hardware is modelled.

    points: where each screw goes on the parent's face (one (x, y, z) or a list). axis: from parent toward child, whose
    near face sits 0.1-0.3 mm off the parent face (touching faces fail the geometry check). screw: 'M2', 'M2.5', 'M3', 'M4' or 'M5'. The parent needs a post or block under each point,
    at least pocket diameter + 3 mm wide and insert_length + relief + 1.5 mm deep.
    insert_diameter / insert_length: the insert's outside size and length (typical values for the screw are used otherwise).
    melt: the pocket is this much narrower than the insert so the melted plastic grips it. thickness: child thickness
    along axis for the counterbore (measured from the child by default).
    Fixed joint, held only by the screw and insert, which are not modelled: validation reports `unretained_part`.
    """
    if screw not in _SCREWS:
        raise ValueError('insert_boss: screw must be one of ' + ', '.join(_SCREWS))
    shank, head, head_height, od, inlen = _SCREWS[screw]
    od = insert_diameter or od
    inlen = insert_length or inlen
    plane = _points(points)
    far = thickness if thickness is not None else _extent(child, plane[0], axis)
    cb_depth = head_height + 0.3
    if far < cb_depth + 1.5:
        raise ValueError('insert_boss: child is %.1f mm thick; the counterbore needs at least %.1f mm' % (far, cb_depth + 1.5))
    for jitter in _tries('insert_boss', parent, child):
        for point in plane:
            world = frame(point, axis)
            pocket = rotate(cylinder('_pocket', od / 2 - melt / 2, inlen + relief + 1, (0, 0, -(inlen + relief) / 2 + 0.5)), 'Z', jitter)
            cut(parent, place(pocket, world))
            cut(child, place(rotate(cylinder('_hole', shank / 2 + 0.2, far + 2, (0, 0, far / 2)), 'Z', jitter), world),
                place(rotate(cylinder('_counterbore', head / 2 + 0.3, cb_depth + 1, (0, 0, far - cb_depth + (cb_depth + 1) / 2)), 'Z', jitter), world))
        require_one_solid(parent, 'insert_boss', 'The pocket must not split the parent; put it in a thicker post or block.')
        require_one_solid(child, 'insert_boss', 'The screw hole must not split the child; keep the point away from its edge.')
        _triangulated(parent, child)
    return joint(name or child.name + 'Screw', 'fixed', parent, child)


# ------------------------------------------------------------------ magnets

def magnet_pockets(parent, child, points, axis, pins=(), magnet_diameter=6, magnet_thickness=3, skin=0.6,
                   clearance=0.1, pin_diameter=5, pin_length=4, pin_clearance=0.2, face_gap=0.2, vent=1.0, name=None):
    """Enclosed disc-magnet cavities in both parts, facing each other behind thin skins, plus optional locating pins.

    points: magnet centres on the parent's face (one (x, y, z) or a list); the child's matching cavities sit straight across. axis: from parent toward child. skin: printed layer between each magnet and the mating face.
    pins: points for locating pins on the parent (blind holes in the child); the first has pin_diameter, the others 70 %
    of it, so the parts fit together only one way. pin_clearance: gap per side in the holes.
    face_gap: gap between the parent's mating face and the child's face; touching faces fail the geometry check.
    vent: diameter of a pinhole through each skin to the cavity, at least 0.6; a fully sealed cavity is a second mesh
    shell, which the kit's Boolean check and the validator reject. Magnets are not modelled; pause the print at the
    cavity top to drop them in, opposite poles facing.
    Fixed joint, held only by magnetism and the pins: validation reports `unretained_part`.
    """
    if skin < 0.4 or magnet_thickness < 1 or vent < 0.6:
        raise ValueError('magnet_pockets: skin must be at least 0.4 mm, magnet_thickness at least 1 mm and vent at least 0.6 mm')
    radius = magnet_diameter / 2 + clearance
    cavity = magnet_thickness + 2 * clearance
    centres = _points(points)
    for jitter in _tries('magnet_pockets', parent, child):
        for index, point in enumerate(_points(pins)):
            pin = pin_diameter / 2 * (1 if index == 0 else 0.7)
            world = frame(point, axis)
            chamfer = min(0.8, pin / 2)
            peg = rotate(lathe('_pin', [(0, -1.5), (pin, -1.5), (pin, pin_length - chamfer), (pin - chamfer, pin_length), (0, pin_length)]), 'Z', jitter)
            join(parent, place(peg, world))
            deep = pin_length + 1
            cut(child, place(rotate(cylinder('_hole', pin + pin_clearance, deep + 1, (0, 0, face_gap + (deep - 1) / 2)), 'Z', jitter), world))
        # One boolean per part: Blender's exact solver drops a second fully enclosed tool once the target already has a cavity.
        for part, near, reach in ((parent, -skin - cavity / 2, (-skin - 0.5, 1)), (child, face_gap + skin + cavity / 2, (face_gap - 1, face_gap + skin + 0.5))):
            tools = []
            for point in centres:
                world = frame(point, axis)
                tool = place(rotate(cylinder('_cavity', radius, cavity, (0, 0, near)), 'Z', jitter), world)
                join(tool, place(cylinder('_vent', vent / 2, reach[1] - reach[0], (0, 0, (reach[0] + reach[1]) / 2), segments=24), world))
                tools.append(tool)
            cut(part, join(tools[0], *tools[1:]))
        for part, label in ((parent, 'parent'), (child, 'child')):
            if solids(part) != 1:
                raise ValueError('magnet_pockets: the %s is in several pieces after the cavities; check the points lie on its face and pins sit on the parent face' % label)
        _triangulated(parent, child)
    return joint(name or child.name + 'Magnets', 'fixed', parent, child)
