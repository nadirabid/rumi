"""Separate-print fastener recipes: snap hook, snap lid, bayonet lock, helical bolt/nut, tab-slot, pegs, key, magnets, inserts.

Built with exact build123d B-Rep geometry (including real NURBS helical threads via `build123d.Helix`).
Kit names are injected by `cad/rumi_joints.py`.
"""
import math


def _check_perp(recipe, axis, other, other_name):
    if abs(direction(axis).dot(direction(other))) > 1e-3:
        raise ValueError(f'{recipe}: {other_name} must be perpendicular to axis')


def _points_list(points):
    if len(points) and not hasattr(points[0], '__len__'):
        return [tuple(points)]
    return [tuple(p) for p in points]


def _extent_along(obj, pivot, axis):
    world = frame(pivot, axis)
    return _local_extents(obj, world)[2][1]


def _funnel_cutter(low, high, face_z, inward, leads):
    """Exact B-Rep rectangular lead-in chamfer frustum for a window at `z = face_z`."""
    depth = max(leads)
    if depth <= 0:
        return None

    def rect_wire(z, outer):
        margins = [(lead + 0.5 if outer else max(lead - depth, 0.0)) if lead else -0.2 for lead in leads]
        x0, x1 = low[0] - margins[0], high[0] + margins[1]
        y0, y1 = low[1] - margins[2], high[1] + margins[3]
        return b3d.Wire.make_polygon([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z), (x0, y0, z)])

    w_out = rect_wire(face_z - inward * 0.5, True)
    w_in = rect_wire(face_z + inward * depth, False)
    solid = b3d.Solid.make_loft([w_out, w_in], ruled=True)
    return _register('_funnel', solid)


# ------------------------------------------------------------------ snap hook

def snap_hook(
    parent,
    child,
    pivot,
    axis,
    hook_side,
    width=8,
    wall=3,
    arm_thickness=2,
    hook_height=1.4,
    standoff=9,
    clearance=0.35,
    play=0.3,
    lead_in=0.7,
    name=None,
):
    """Cantilever snap hook on `child` clicking through a chamfered window in `parent`'s wall.

    Fixed joint with `retainer='snap'` and verified snap disassembly step.
    """
    _check_perp('snap_hook', axis, hook_side, 'hook_side')
    t, h, c = float(arm_thickness), float(hook_height), float(clearance)
    if h <= c + 0.35 or h > 2.0 or t < 1.2 or width < 4 or standoff < 6 or wall < 1.5:
        raise ValueError('snap_hook: need clearance + 0.35 < hook_height <= 2.0, arm_thickness >= 1.2, width >= 4, standoff >= 6, wall >= 1.5')
    back = standoff + 3.0
    ret = wall + play
    tip = ret + 0.5 + h / math.tan(math.radians(30))
    root = t / 2.0 + 0.8 * t
    outline = [
        (-t / 2.0, -back), (-t / 2.0, tip), (t / 2.0, tip),
        (t / 2.0 + h, ret + 0.5), (t / 2.0 + h, ret), (t / 2.0, ret),
        (t / 2.0, -(standoff - 6.0)), (root, -(standoff + 1.0)), (root, -back),
    ]
    arm = prism('_arm', outline, width, (0, 0, 0), '-Y', 'X')
    flex = 1.6
    floor_top = -t / 2.0 - h
    tongue = box2('_tongue', (floor_top - flex, -width / 2.0, -back), (floor_top, width / 2.0, wall - play))
    near, far = width / 2.0 + c + 0.5, width / 2.0 + c + 6.2
    shoulders = [box2('_shoulder', (-6.0, lo, -back), (6.0, hi, -play)) for lo, hi in ((near, far), (-far, -near))]
    window = box2('_window', (floor_top - flex - c, -width / 2.0 - c, -2.0), (t / 2.0 + c, width / 2.0 + c, wall + 2.0))
    world = frame(pivot, axis, hook_side)

    cut(parent, place(window, world))
    if lead_in:
        low_xy = (floor_top - flex - c, -width / 2.0 - c)
        high_xy = (t / 2.0 + c, width / 2.0 + c)
        catch_lead = min(0.35, (h - c) * 0.35)
        cut(
            parent,
            place(_funnel_cutter(low_xy, high_xy, 0.0, 1.0, (lead_in,) * 4), world),
            place(_funnel_cutter(low_xy, high_xy, wall, -1.0, (lead_in, catch_lead, lead_in, lead_in)), world),
        )
    join(child, place(arm, world), place(tongue, world), *[place(s, world) for s in shoulders])
    require_one_solid(child, 'snap_hook', 'Bring child to standoff mm behind the wall face and cover the arm and shoulders.')
    require_one_solid(parent, 'snap_hook', 'The window must sit inside the wall without splitting it.')

    ax = direction(axis)
    rec = joint(name or (child.name + 'Snap'), 'fixed', parent, child, retainer='snap')
    snap_dist = tip + 1.0
    total_clear = _clear_distance(child, [parent], -ax)
    pull_dist = max(0.0, total_clear - snap_dist)
    steps = [
        step_snap(
            child,
            (-ax) * snap_dist,
            max_interference_mm=min(2.4, h + 0.5),
            pull=((-ax) * pull_dist) if pull_dist > 0.5 else None,
            mate=parent,
        )
    ]
    return RecipeResult([rec], parts=[], steps=steps)


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


def _offset_line(start, end, dist):
    dx, dz = end[0] - start[0], end[1] - start[1]
    length = math.hypot(dx, dz)
    dx, dz = dx / length, dz / length
    return ((start[0] + dz * dist, start[1] - dx * dist), (dx, dz))


def snap_lid(
    parent,
    child,
    pivot,
    axis,
    radius,
    bead=0.8,
    bead_depth=3.8,
    skirt_wall=2.2,
    skirt_depth=None,
    clearance=0.35,
    seat=0.3,
    gap=0.35,
    keys=2,
    key_width=3.0,
    xdir=None,
    name=None,
):
    """Round snap-on lid: annular bead on container `parent` + grooved skirt on lid `child` + anti-spin keys.

    Fixed joint with `retainer='snap'` and verified snap disassembly step.
    """
    if not (0.5 <= bead <= 1.2) or radius < 8.0 or skirt_wall < 1.5:
        raise ValueError('snap_lid: bead must be 0.5..1.2 mm, radius >= 8 mm, skirt_wall >= 1.5 mm')
    span = 2.75 * bead + 0.4
    bottom = -bead_depth - span
    depth = skirt_depth if skirt_depth is not None else bead_depth + span + 1.4
    if depth < bead_depth + span + 0.8:
        raise ValueError('snap_lid: skirt_depth must reach at least 0.8 mm below the bead')
    world = frame(pivot, axis, xdir)

    ring = lathe('_bead', [
        (radius - 0.6, bottom), (radius, bottom), (radius + bead, bottom + bead),
        (radius + bead, bottom + bead + 0.4), (radius, -bead_depth), (radius - 0.6, -bead_depth),
    ])
    join(parent, place(ring, world))

    low = (radius, bottom), (radius + bead, bottom + bead)
    flat = (radius + bead, bottom + bead), (radius + bead, bottom + bead + 0.4)
    high = (radius + bead, bottom + bead + 0.4), (radius, -bead_depth)
    lines = [_offset_line(a, b, seat) for a, b in (low, flat, high)]
    groove_shape = [_at_radius(lines[0], radius), _meet(lines[0], lines[1]), _meet(lines[1], lines[2]), _at_radius(lines[2], radius)]

    inner = radius + clearance
    skirt = lathe('_skirt', [(inner, -depth), (inner + skirt_wall, -depth), (inner + skirt_wall, gap + 1.2), (inner, gap + 1.2)])
    join(child, place(skirt, world))
    cut(child, place(lathe('_groove', groove_shape), world))
    for index in range(int(keys)):
        angle = 360.0 * index / keys
        rib = box2('_key', (radius - 0.5, -key_width / 2.0, bottom - 0.6), (radius + 1.0, key_width / 2.0, -0.6))
        chamfer(rib, 0.3)
        rotate(rib, 'Z', angle)
        join(parent, place(rib, world))
        notch_c = clearance + 0.1
        notch = rotate(box2('_notch', (radius, -key_width / 2.0 - notch_c, -depth - 1.0), (radius + 1.0 + notch_c, key_width / 2.0 + notch_c, -0.2)), 'Z', angle)
        cut(child, place(notch, world))

    require_one_solid(parent, 'snap_lid', 'Container wall must be a cylinder of the given radius at the bead.')
    require_one_solid(child, 'snap_lid', 'Make lid plate >= 1.5 mm thick with underside gap mm above the rim.')

    ax = direction(axis)
    rec = joint(name or (child.name + 'Snap'), 'fixed', parent, child, retainer='snap')
    snap_dist = depth + 1.2
    total_clear = _clear_distance(child, [parent], ax)
    pull_dist = max(0.0, total_clear - snap_dist)
    steps = [
        step_snap(
            child,
            ax * snap_dist,
            max_interference_mm=min(2.4, bead + 0.55),
            pull=(ax * pull_dist) if pull_dist > 0.5 else None,
            mate=parent,
        )
    ]
    return RecipeResult([rec], parts=[], steps=steps)


# ------------------------------------------------------------------ bayonet lock

def bayonet_lock(
    parent,
    child,
    pivot,
    axis,
    bore_diameter=20,
    lugs=3,
    lug_reach=2.5,
    lug_thickness=3.0,
    lug_angle=24.0,
    turn=45.0,
    lip=4.0,
    depth=16.0,
    notch=0.0,
    clearance=0.35,
    gap=0.4,
    lead_in=0.6,
    start_angle=90.0,
    xdir=None,
    name=None,
):
    """Twist-lock bayonet plug: radial lugs on `child` lock under a lip in L-slots cut into `parent`.

    Fixed joint with `retainer='bayonet'` and verified twist-and-pull disassembly step.
    """
    if lugs not in (2, 3, 4):
        raise ValueError('bayonet_lock: lugs must be 2, 3, or 4')
    if clearance < 0.3:
        raise ValueError('bayonet_lock: clearance must be at least 0.3 mm')
    bore = bore_diameter / 2.0
    stem = bore - clearance
    lug_radius = bore + lug_reach
    slot_radius = lug_radius + clearance
    deg_pad = math.degrees(math.asin(min(0.6, (clearance + 0.08) / bore)))
    half = lug_angle / 2.0 + deg_pad
    if abs(turn) < lug_angle + 2.0 * deg_pad + 6.0 or (lug_angle + 2.0 * deg_pad + 10.0) * lugs > 360.0:
        raise ValueError('bayonet_lock: turn is too small or lugs do not fit around the stem')
    height = lug_thickness + 2.0 * clearance + 0.35
    if depth < lip + height + 3.0 + notch:
        raise ValueError('bayonet_lock: depth must be at least lip + lug_thickness + 4.0 mm + notch')
    if notch and gap < notch + 0.35:
        raise ValueError('bayonet_lock: gap must be at least notch + 0.35 mm')

    floor = -lip - height
    # Extra floor margin under lugs so under gravity the cap rests flat on the socket top face instead of the bore edge.
    low_lug = floor + clearance + 0.35 - notch
    world = frame(pivot, axis, xdir)

    cut(parent, place(cylinder('_bore', bore, depth + 1.0, (0, 0, -depth / 2.0 + 0.5)), world))
    stem_part = cylinder('_stem', stem, depth - 2.0 + gap + 1.5, (0, 0, (-(depth - 2.0) + gap + 1.5) / 2.0))
    join(child, place(stem_part, world))

    # Bevel the inner rim of the channel ceiling and floor at r = bore so lugs bear on flat interior faces.
    if lead_in:
        bev = min(float(lead_in), lug_reach * 0.3)
        for level, sign in ((floor + height, 1.0), (floor, -1.0)):
            cut(parent, place(lathe('_ch_bev', [
                (bore - 0.5, level), (bore + bev, level),
                (bore, level + sign * bev), (bore - 0.5, level + sign * bev),
            ]), world))

    for index in range(lugs):
        locked = start_angle + 360.0 * index / lugs
        entry = locked - turn
        lo_a, hi_a = min(entry, locked) - half, max(entry, locked) + half
        cut(
            parent,
            place(_sector_prism(bore - 1.0, slot_radius, entry - half, entry + half, floor, 1.5), world),
            place(_sector_prism(bore - 1.0, slot_radius, lo_a, hi_a, floor, floor + height), world),
        )
        if notch:
            side = half + 1.0
            cut(parent, place(_sector_prism(bore - 1.0, slot_radius, locked - side, locked + side, floor - notch, floor + 0.5), world))
        lug = _sector_prism(stem - 1.0, lug_radius, locked - lug_angle / 2.0, locked + lug_angle / 2.0, low_lug, low_lug + lug_thickness)
        join(child, place(lug, world))

    require_one_solid(child, 'bayonet_lock', 'Put the cap underside gap mm above the socket face and wider than the stem.')
    require_one_solid(parent, 'bayonet_lock', 'Leave solid wall round the bore so the slots do not split the socket.')

    ax = direction(axis)
    rec = joint(name or (child.name + 'Bayonet'), 'fixed', parent, child, axis=ax, pivot=pivot, retainer='bayonet')
    pull = ax * _clear_distance(child, [parent], ax)
    pre = (ax * (notch + 0.05)) if notch else None
    steps = [step_twist(child, pivot, ax, -turn, pull=pull, pre_translate=pre)]
    return RecipeResult([rec], parts=[], steps=steps)


# ------------------------------------------------------------------ helical bolt and nut

def _helix_thread_solid(profile, pitch, z_from, z_to):
    """Build an exact analytic B-Rep helical thread solid by sweeping `profile` [(r, dz), ...] along a right-handed helix."""
    height = z_to - z_from
    r_mid = sum(r for r, _ in profile) / len(profile)
    helix = b3d.Helix(pitch=pitch, height=height, radius=r_mid, center=(0, 0, z_from), direction=(0, 0, 1))
    # Build the cross-section wire in the XZ plane starting at z = z_from (matching the helix start at angle = 0).
    pts = [(r, 0.0, z_from + dz) for r, dz in profile]
    pts.append(pts[0])
    face = b3d.Face(b3d.Wire.make_polygon(pts))
    solid = b3d.sweep(face, path=helix, is_frenet=True)
    return _register('_thread', solid)


def bolt_nut(parent, child, pivot, axis, diameter=12, pitch=2.5, length=18, seat=2.0, clearance=0.35, name=None):
    """Real analytic B-Rep helical thread: bolt stud on `parent`, matching internal thread cut through `child` nut.

    Fixed joint with `retainer='threaded'` and verified helical unscrewing disassembly step.
    """
    if not (8 <= diameter <= 30) or not (2.0 <= pitch <= 4.0) or diameter / pitch < 3.0:
        raise ValueError('bolt_nut: diameter must be 8..30 mm, pitch 2..4 mm, and diameter >= 3 * pitch')
    if length - seat < 2.0 * pitch or seat < 0.35:
        raise ValueError('bolt_nut: seat must be >= 0.35 mm and length >= seat + 2 * pitch')
    tan30 = math.tan(math.radians(30))
    crest = diameter / 2.0 - 0.15
    crest_flat = 0.175 * pitch
    root = crest - 0.425 * pitch
    if root < 3.0:
        raise ValueError('bolt_nut: thread core diameter would be under 6 mm; use a larger diameter')
    flank = clearance / math.cos(math.radians(30))
    nut_crest = root + clearance
    nut_root = crest + clearance
    embed = 0.35

    def ridge_w(r):
        return crest_flat + 2.0 * tan30 * (crest - r)

    stud_prof = [
        (root - 0.25, -(ridge_w(root) / 2.0 + tan30 * 0.25)),
        (crest, -crest_flat / 2.0),
        (crest, crest_flat / 2.0),
        (root - 0.25, ridge_w(root) / 2.0 + tan30 * 0.25),
    ]
    valley_prof = [
        (nut_crest - embed, -(ridge_w(nut_crest) / 2.0 + flank + tan30 * embed)),
        (nut_root, -(ridge_w(nut_root) / 2.0 + flank)),
        (nut_root, ridge_w(nut_root) / 2.0 + flank),
        (nut_crest - embed, ridge_w(nut_crest) / 2.0 + flank + tan30 * embed),
    ]

    world = frame(pivot, axis)
    # Start both external and internal helices at exact integer multiples of `pitch` so thread phases match identically.
    stud_z0 = -pitch
    stud_z1 = math.ceil((length + pitch) / pitch) * pitch
    ridge = _helix_thread_solid(stud_prof, pitch, stud_z0, stud_z1)
    core = cylinder('_core', root, length + 2.5, (0, 0, (length - 1.5) / 2.0))
    join(core, ridge)
    # Envelope trims the swept thread flush to the stud root/tip with a 45-deg tip lead-in chamfer.
    env = lathe('_env', [
        (0.0, -1.5), (crest + 0.5, -1.5), (crest + 0.5, length - 0.8),
        (root, length), (0.0, length),
    ])
    common(core, env)
    join(parent, place(core, world))

    # Fuse cylindrical bore and helical thread groove over the exact same Z span before subtracting from child nut.
    child_top = _local_extents(child, world)[2][1]
    cut_top = max(length, child_top) + 1.5
    nut_z0 = math.floor((seat - 1.5 - pitch) / pitch) * pitch
    nut_z1 = math.ceil((cut_top + pitch) / pitch) * pitch
    nut_cutter = cylinder('_hole', nut_crest, (nut_z1 - nut_z0) + 2.0, (0, 0, (nut_z0 + nut_z1) / 2.0))
    valley = _helix_thread_solid(valley_prof, pitch, nut_z0, nut_z1)
    join(nut_cutter, valley)
    cut(child, place(nut_cutter, world))

    require_one_solid(parent, 'bolt_nut', 'Put pivot on the parent face with >= 1.5 mm material under it.')
    require_one_solid(child, 'bolt_nut', 'Make the nut wider than the thread major diameter.')

    ax = direction(axis)
    rec = joint(name or (child.name + 'Thread'), 'fixed', parent, child, axis=ax, pivot=pivot, retainer='threaded')
    # Right-handed helix: +360 deg about +axis advances +pitch along +axis, unscrewing the nut cleanly off the stud.
    unscrew_z = (length - seat) + pitch * 0.6
    turns = unscrew_z / pitch
    total_clear = _clear_distance(child, [parent], ax)
    pull_extra = max(0.0, total_clear - unscrew_z)
    steps = [
        step_twist(
            child,
            pivot,
            ax,
            360.0 * turns,
            pitch_mm=pitch,
            pull=(ax * pull_extra) if pull_extra > 0.5 else None,
        )
    ]
    return RecipeResult([rec], parts=[], steps=steps)


# ------------------------------------------------------------------ tab and slot

def tab_slot(
    parent,
    child,
    pivot,
    axis,
    across,
    tabs=(-12, 12),
    tab_width=10,
    tab_thickness=3,
    plate=4,
    barb=1.0,
    clearance=0.35,
    play=0.3,
    relief=0.0,
    gap=0.35,
    lead_in=0.6,
    name=None,
):
    """Split barbed tabs on `child` snapping through chamfered slots in `parent`'s plate.

    Fixed joint with `retainer='snap'` and verified snap disassembly step.
    """
    _check_perp('tab_slot', axis, across, 'across')
    slit = 2.0 * (barb + clearance) + 0.4
    if tab_width < slit + 3.2 or tab_thickness < 1.5 or plate < 1.5 or not (0.45 <= barb <= 1.5):
        raise ValueError(f'tab_slot: need tab_width >= {slit + 3.2:.1f}, tab_thickness >= 1.5, plate >= 1.5, barb in 0.45..1.5')
    half = tab_width / 2.0
    catch = -(plate + play)
    end = catch - 2.2
    top = gap + relief + 1.6
    world = frame(pivot, axis, across)

    for x in tabs:
        low_xy = (x - half - clearance, -tab_thickness / 2.0 - clearance)
        high_xy = (x + half + clearance, tab_thickness / 2.0 + clearance)
        if relief:
            cut(child, place(box2('_relief', (*low_xy, gap - 1.0), (*high_xy, gap + relief)), world))
        for sign in (1.0, -1.0):
            outline = [
                (sign * u, v) for u, v in [
                    (slit / 2.0, top), (half, top), (half, catch),
                    (half + barb, catch), (slit / 2.0 + 0.4, end), (slit / 2.0, end),
                ]
            ]
            join(child, place(prism('_prong', outline, tab_thickness, (x, 0, 0), '-Y', 'X'), world))
        cut(parent, place(box2('_slot', (*low_xy, -plate - 2.0), (*high_xy, 1.5)), world))
        if lead_in:
            catch_lead = min(0.35, (barb - clearance) * 0.4)
            cut(
                parent,
                place(_funnel_cutter(low_xy, high_xy, 0.0, -1.0, (lead_in,) * 4), world),
                place(_funnel_cutter(low_xy, high_xy, -plate, 1.0, (catch_lead, catch_lead, lead_in, lead_in)), world),
            )
    require_one_solid(child, 'tab_slot', 'Make child solid for 1.6 mm above the plate face across every tab.')
    require_one_solid(parent, 'tab_slot', 'Slots split the plate; move tabs apart or away from the edge.')

    ax = direction(axis)
    rec = joint(name or (child.name + 'Tabs'), 'fixed', parent, child, retainer='snap')
    snap_dist = (-end) + 1.0
    total_clear = _clear_distance(child, [parent], ax)
    pull_dist = max(0.0, total_clear - snap_dist)
    steps = [
        step_snap(
            child,
            ax * snap_dist,
            max_interference_mm=min(2.4, barb + 0.55),
            pull=(ax * pull_dist) if pull_dist > 0.5 else None,
            mate=parent,
        )
    ]
    return RecipeResult([rec], parts=[], steps=steps)


# ------------------------------------------------------------------ press pegs

def press_pegs(
    parent,
    child,
    points,
    axis,
    diameter=5,
    length=8,
    clearance=0.15,
    chamfer_size=0.6,
    hole_depth=None,
    gap=0.3,
    pegs_on='parent',
    name=None,
):
    """Chamfered round press-fit pegs on one part pressed into blind holes in the other.

    Fixed joint with `retainer='friction'` (reports unverified friction warning in Bullet) and translation disassembly.
    """
    if pegs_on not in ('parent', 'child'):
        raise ValueError("press_pegs: pegs_on must be 'parent' or 'child'")
    if diameter < 3.0 or chamfer_size >= diameter / 2.0 - 0.5 or length < 2.0:
        raise ValueError('press_pegs: need diameter >= 3, length >= 2, chamfer_size < radius - 0.5')
    outward = direction(axis) if pegs_on == 'parent' else -direction(axis)
    pegged, holed = (parent, child) if pegs_on == 'parent' else (child, parent)
    depth = hole_depth if hole_depth is not None else length + 1.0
    radius = diameter / 2.0

    for point in _points_list(points):
        world = frame(point, outward)
        peg = lathe('_peg', [(0.0, -1.5), (radius, -1.5), (radius, length - chamfer_size), (radius - chamfer_size, length), (0.0, length)])
        join(pegged, place(peg, world))
        hole = cylinder('_hole', radius + clearance, depth + 1.0, (0, 0, gap + (depth - 1.0) / 2.0))
        cut(holed, place(hole, world))
    require_one_solid(pegged, 'press_pegs', 'Put each point on the face of the peg part.')
    require_one_solid(holed, 'press_pegs', 'Make the holed part thicker than hole_depth.')

    ax = direction(axis)
    rec = joint(name or (child.name + 'Pegs'), 'fixed', parent, child, retainer='friction')
    steps = [step_translate(child, ax * _clear_distance(child, [parent], ax))]
    return RecipeResult([rec], parts=[], steps=steps)


# ------------------------------------------------------------------ dog-bone key

def dogbone_key(
    parent,
    child,
    pivot,
    axis,
    lift,
    length=18,
    bulb_diameter=11,
    neck_width=5,
    height=4.5,
    clearance=0.35,
    recess=0.35,
    name=None,
):
    """Separate drop-in dog-bone key bridging a seam between two plates (separate-print only).

    Returns a `RecipeResult` creating the key part, friction-retainer fixed joints, and translation steps.
    """
    _check_perp('dogbone_key', axis, lift, 'lift')
    if neck_width + 2.0 > bulb_diameter or length < bulb_diameter * 1.4 or height < 2.0:
        raise ValueError('dogbone_key: bulb_diameter >= neck_width + 2, length >= 1.4 * bulb_diameter, height >= 2')
    offset = (length - bulb_diameter) / 2.0
    top = -recess
    bottom = top - height
    floor, roof = bottom - clearance, 1.5
    world = frame(pivot, lift, axis)
    key_name = name or 'DogboneKey'

    def make_shape(sname, pad, z0, z1):
        bulbs = [cylinder('_bulb', bulb_diameter / 2.0 + pad, z1 - z0, (sign * offset, 0, (z0 + z1) / 2.0)) for sign in (1.0, -1.0)]
        neck = box2(sname, (-offset, -neck_width / 2.0 - pad, z0), (offset, neck_width / 2.0 + pad, z1))
        return join(neck, *bulbs)

    pocket = place(make_shape('_pocket', clearance, floor, roof), world)
    cut(parent, pocket, keep=True)
    cut(child, pocket)
    key = place(make_shape(key_name, 0.0, bottom, top), world)
    require_one_solid(parent, 'dogbone_key', 'Make the parent plate thicker than the pocket.')
    require_one_solid(child, 'dogbone_key', 'Make the child plate thicker than the pocket.')
    require_one_solid(key, 'dogbone_key', 'Check dogbone_key dimensions.')

    lift_dir = direction(lift)
    ax = direction(axis)
    j_seam = joint(key_name + 'Seam', 'fixed', parent, child, retainer='friction')
    j_key = joint(key_name + 'Joint', 'fixed', parent, key, retainer='friction')
    steps = [
        step_translate(key, lift_dir * _clear_distance(key, [parent, child], lift_dir)),
        step_translate(child, ax * _clear_distance(child, [parent], ax)),
    ]
    return RecipeResult([j_seam, j_key], parts=[key], steps=steps, key=key)


# ------------------------------------------------------------------ heat-set insert and screw

_SCREWS = {
    'M2': (2.0, 3.8, 2.0, 3.2, 4.0),
    'M2.5': (2.5, 4.5, 2.5, 3.6, 5.0),
    'M3': (3.0, 5.5, 3.0, 4.6, 5.7),
    'M4': (4.0, 7.0, 4.0, 5.6, 8.1),
    'M5': (5.0, 8.5, 5.0, 6.4, 9.5),
}


def insert_boss(
    parent,
    child,
    points,
    axis,
    screw='M3',
    insert_diameter=None,
    insert_length=None,
    melt=0.4,
    relief=0.6,
    thickness=None,
    name=None,
):
    """Heat-set insert pocket in `parent` + clearance hole with counterbore in `child` (hardware not modelled).

    Fixed joint with `retainer='friction'` and translation disassembly step.
    """
    if screw not in _SCREWS:
        raise ValueError('insert_boss: screw must be one of ' + ', '.join(_SCREWS))
    shank, head, head_h, od, inlen = _SCREWS[screw]
    od = insert_diameter or od
    inlen = insert_length or inlen
    pts = _points_list(points)
    far = thickness if thickness is not None else _extent_along(child, pts[0], axis)
    cb_depth = head_h + 0.3
    if far < cb_depth + 1.5:
        raise ValueError(f'insert_boss: child thickness {far:.1f} mm is too thin for counterbore (need >= {cb_depth + 1.5:.1f})')

    for point in pts:
        world = frame(point, axis)
        cut(parent, place(cylinder('_pocket', od / 2.0 - melt / 2.0, inlen + relief + 1.0, (0, 0, -(inlen + relief) / 2.0 + 0.5)), world))
        cut(
            child,
            place(cylinder('_hole', shank / 2.0 + 0.25, far + 2.0, (0, 0, far / 2.0)), world),
            place(cylinder('_cbore', head / 2.0 + 0.35, cb_depth + 1.0, (0, 0, far - cb_depth + (cb_depth + 1.0) / 2.0)), world),
        )
    require_one_solid(parent, 'insert_boss', 'Pocket split parent; place in a thicker boss.')
    require_one_solid(child, 'insert_boss', 'Screw hole split child; move away from edges.')

    ax = direction(axis)
    rec = joint(name or (child.name + 'Screw'), 'fixed', parent, child, retainer='friction')
    steps = [step_translate(child, ax * _clear_distance(child, [parent], ax))]
    return RecipeResult([rec], parts=[], steps=steps)


# ------------------------------------------------------------------ magnet pockets

def magnet_pockets(
    parent,
    child,
    points,
    axis,
    pins=(),
    magnet_diameter=6,
    magnet_thickness=3,
    skin=0.6,
    clearance=0.2,
    pin_diameter=5,
    pin_length=4,
    pin_clearance=0.25,
    face_gap=0.3,
    vent=1.0,
    name=None,
):
    """Enclosed disc-magnet cavities with vent holes in both parts plus optional keyed locating pins.

    Fixed joint with `retainer='friction'` (magnets are not modelled) and translation disassembly step.
    """
    if skin < 0.4 or magnet_thickness < 1.0 or vent < 0.6:
        raise ValueError('magnet_pockets: need skin >= 0.4, magnet_thickness >= 1.0, vent >= 0.6')
    radius = magnet_diameter / 2.0 + clearance
    cavity = magnet_thickness + 2.0 * clearance

    for index, point in enumerate(_points_list(pins)):
        pin_r = (pin_diameter / 2.0) * (1.0 if index == 0 else 0.7)
        world = frame(point, axis)
        ch = min(0.8, pin_r / 2.0)
        peg = lathe('_pin', [(0.0, -1.5), (pin_r, -1.5), (pin_r, pin_length - ch), (pin_r - ch, pin_length), (0.0, pin_length)])
        join(parent, place(peg, world))
        deep = pin_length + 1.0
        cut(child, place(cylinder('_hole', pin_r + pin_clearance, deep + 1.0, (0, 0, face_gap + (deep - 1.0) / 2.0)), world))

    for point in _points_list(points):
        world = frame(point, axis)
        for target, near_z, reach_z in (
            (parent, -skin - cavity / 2.0, (-skin - 0.5, 1.0)),
            (child, face_gap + skin + cavity / 2.0, (face_gap - 1.0, face_gap + skin + 0.5)),
        ):
            cav = cylinder('_cavity', radius, cavity, (0, 0, near_z))
            v_cyl = cylinder('_vent', vent / 2.0, reach_z[1] - reach_z[0], (0, 0, (reach_z[0] + reach_z[1]) / 2.0))
            join(cav, v_cyl)
            cut(target, place(cav, world))

    require_one_solid(parent, 'magnet_pockets', 'Cavities split parent; thicken parent around magnet points.')
    require_one_solid(child, 'magnet_pockets', 'Cavities split child; thicken child around magnet points.')

    ax = direction(axis)
    rec = joint(name or (child.name + 'Magnets'), 'fixed', parent, child, retainer='friction')
    steps = [step_translate(child, ax * _clear_distance(child, [parent], ax))]
    return RecipeResult([rec], parts=[], steps=steps)
