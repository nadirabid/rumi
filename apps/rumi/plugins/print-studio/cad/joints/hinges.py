"""Separate-print rotational joint recipes: pin hinge, snap hinge, ball socket, turntable, bearing.

Kit names (box, cylinder, sphere, prism, lathe, cut, join, chamfer, frame, place, joint,
step_translate, step_twist, step_snap, RecipeResult, ...) are injected by `cad/rumi_joints.py`.
"""
import math


def pin_hinge(
    parent,
    child,
    pivot,
    axis,
    parent_side,
    child_side,
    length=32,
    knuckle_diameter=13,
    pin_diameter=6.5,
    reach=None,
    web_thickness=None,
    clearance=0.40,
    pin_clearance=0.35,
    barrel_fraction=0.5,
    turn=90,
    limits=(0, 110),
    control=None,
    name=None,
    pin_name=None,
    cap_name=None,
):
    """4-part separate-print pin hinge: parent outer knuckles + child center knuckle + removable keyed pin + bayonet end cap.

    Every part prints flat separately. Assemble by aligning the knuckles, sliding the headed pin
    through from `-axis` (anti-spin key seats in the bottom outer knuckle), and twisting the end cap
    90 degrees onto the `+axis` tip.
    """
    if clearance < 0.3 or pin_clearance < 0.3:
        raise ValueError('pin_hinge: clearance and pin_clearance must be at least 0.3 mm')
    if pin_diameter < 6.0:
        raise ValueError('pin_hinge: pin_diameter must be at least 6.0 mm for the bayonet locking cap')
    radius = knuckle_diameter / 2.0
    pin_r = pin_diameter / 2.0
    bore = pin_r + pin_clearance
    if radius - bore < 1.8:
        raise ValueError('pin_hinge: knuckle wall would be under 1.8 mm; increase knuckle_diameter or reduce pin_diameter')
    reach_d = reach if reach is not None else radius + 3.5
    thick = web_thickness if web_thickness is not None else min(knuckle_diameter, 4.0)
    centre = length * barrel_fraction
    outer = (length - centre - 2.0 * clearance) / 2.0
    if outer < 4.0:
        raise ValueError(f'pin_hinge: length {length:.1f} leaves outer knuckles under 4 mm; use length >= 24 mm')

    p_world = frame(pivot, axis, parent_side)
    c_world = frame(pivot, axis, child_side)

    def make_knuckle(low, high, world_frame):
        barrel = cylinder('_knuckle', radius, high - low, (0, 0, (low + high) / 2.0))
        chamfer(barrel, 0.35)
        web = box2('_web', (0.0, -thick / 2.0, low + 0.35), (reach_d, thick / 2.0, high - 0.35))
        join(barrel, web)
        return place(barrel, world_frame)

    half = centre / 2.0
    middle = make_knuckle(-half, half, c_world)
    cut(middle, place(cylinder('_bore', bore, centre + 4.0), c_world))
    join(child, middle)

    low, high = half + clearance, half + clearance + outer
    upper = make_knuckle(low, high, p_world)
    lower = make_knuckle(-high, -low, p_world)
    join(parent, upper, lower)
    # Straight-through pin bore in both outer knuckles with chamfered outer lead-ins.
    cut(parent, place(_chamfered_bore(bore, -high, high, lead=0.45), p_world))

    # Anti-spin keyway pocket on the -Z face of the lower parent knuckle (along parent_side).
    key_w = min(3.4, thick * 0.7)
    key_depth = 2.2
    key_r0 = bore - 0.5
    key_r1 = radius - 0.6
    key_c = clearance + 0.1
    cut(parent, place(box2('_keyslot', (key_r0, -key_w / 2.0 - key_c, -high - 1.0), (key_r1 + key_c, key_w / 2.0 + key_c, -high + key_depth)), p_world))

    require_one_solid(parent, 'pin_hinge', 'Bring the parent to within reach of the hinge axis on parent_side.')
    require_one_solid(child, 'pin_hinge', 'Bring the child to within reach of the hinge axis on child_side.')

    # Removable headed pin (anti-spin key tab on head at -Z, bayonet locking tip at +Z) + locking cap.
    head_t = 2.8
    head_r = max(bore + 2.2, radius - 0.4)
    z_head_top = -high - clearance
    z_head_bot = z_head_top - head_t
    # Seat cap 0.7 mm above the upper knuckle so under gravity the cap rests flat on the pin tip, never on the bored knuckle rim.
    z_cap = high + clearance + 0.35

    p_label = pin_name or (child.name + 'Pin')
    c_label = cap_name or (child.name + 'PinCap')

    cutters, cap_local, z_tip, _ = _build_bayonet_tip_and_cap(
        pin_r, z_cap, c_label, head_r, clearance=clearance, turn=turn
    )
    pin_local = cylinder(p_label, pin_r, z_tip - z_head_bot, (0, 0, (z_head_bot + z_tip) / 2.0))
    head = cylinder('_pin_head', head_r, head_t, (0, 0, (z_head_bot + z_head_top) / 2.0))
    chamfer(head, 0.35)
    join(pin_local, head)
    # Chamfered anti-spin key tab protruding +Z from the pin head into the bottom outer knuckle's pocket.
    key_tab = box2('_keytab', (bore + 0.2, -key_w / 2.0, z_head_top - 1.0), (key_r1, key_w / 2.0, -high + key_depth - clearance - 0.15))
    chamfer(key_tab, 0.35)
    join(pin_local, key_tab)
    for cutter in cutters:
        cut(pin_local, cutter)

    pin = place(pin_local, p_world)
    cap = place(cap_local, p_world)
    require_one_solid(pin, 'pin_hinge', 'Check pin_diameter and knuckle_diameter.')
    require_one_solid(cap, 'pin_hinge', 'Check pin_diameter and knuckle_diameter.')

    ax = direction(axis)
    cdir = direction(child_side)
    cap_piv = tuple(p_world.to_world((0, 0, z_cap)))
    j_hinge = joint(name or (child.name + 'Hinge'), 'revolute', parent, child, ax, pivot, limits, control)
    j_pin = joint(pin.name + 'Seat', 'fixed', parent, pin, retainer='rigid')
    j_cap = joint(cap.name + 'Lock', 'fixed', pin, cap, axis=ax, pivot=cap_piv, retainer='bayonet')

    all_parts = [parent, child, pin, cap]
    steps = [
        step_twist(cap, cap_piv, ax, -turn, pull=ax * _clear_distance(cap, all_parts, ax)),
        step_translate(pin, (-ax) * _clear_distance(pin, [parent, child], -ax)),
        step_translate(child, cdir * _clear_distance(child, [parent], cdir)),
    ]
    all_joints = [j_hinge, j_pin, j_cap]
    features = [_record_badge_feature('barrel-hinge', all_parts, all_joints)]
    return RecipeResult(all_joints, parts=[pin, cap], steps=steps, features=features, pin=pin, cap=cap)


# Separate-print alias preserving the familiar badge/catalog name.
barrel_hinge = pin_hinge


def snap_hinge(
    parent,
    child,
    pivot,
    axis,
    parent_side,
    child_side,
    length=24,
    post_diameter=6,
    collar_height=9,
    wall=2.2,
    clearance=0.45,
    radial_clearance=0.42,
    opening_deg=95,
    arm_thickness=3,
    reach=None,
    web_thickness=3,
    limits=(-90, 90),
    control=None,
    name=None,
):
    """2-part separate-print snap C-clip hinge: post between arms on `parent` + compliant C-clip leaf on `child`.

    Replaces legacy print-in-place `clip_hinge`. The child's C-clip jaws snap radially over the post
    with bounded elastic interference (`< 1.2 mm`).
    """
    if clearance < 0.3 or radial_clearance < 0.3:
        raise ValueError('snap_hinge: clearance and radial_clearance must be at least 0.3 mm')
    post = post_diameter / 2.0
    inner = post + radial_clearance
    outer = inner + wall
    half = length / 2.0
    top = half - clearance
    low = top - collar_height
    if low < 0.5:
        raise ValueError(f'snap_hinge: collar_height {collar_height:.1f} does not fit in length {length:.1f}')
    if not (60 <= opening_deg <= 140):
        raise ValueError('snap_hinge: opening_deg must be between 60 and 140 degrees')
    chord = 2.0 * inner * math.sin(math.radians(opening_deg / 2.0))
    interference = (post_diameter - chord) / 2.0
    if interference < 0.35:
        raise ValueError(f'snap_hinge: C-opening ({chord:.1f} mm) is too wide to retain a {post_diameter:.1f} mm post')
    if interference > 1.8:
        raise ValueError(f'snap_hinge: jaw snap interference ({interference:.2f} mm) is too stiff; widen opening_deg')
    if direction(parent_side).dot(direction(child_side)) > 0.7:
        raise ValueError('snap_hinge: parent_side and child_side must point to different sides of the axis')

    reach_d = reach if reach is not None else outer + 4.0
    arm_width = post_diameter + 4.0

    arms = []
    for sign in (1.0, -1.0):
        a, b = sorted((sign * half, sign * (half + arm_thickness)))
        arm = box2('_arm', (-post - 2.0, -arm_width / 2.0, a), (reach_d, arm_width / 2.0, b))
        chamfer(arm, 0.35)
        arms.append(arm)
    shaft = cylinder('_post', post, 2.0 * (half + arm_thickness) - 1.0)
    join(arms[0], arms[1], shaft)
    join(parent, place(arms[0], frame(pivot, axis, parent_side)))
    require_one_solid(parent, 'snap_hinge', 'Bring the parent to within reach of the hinge axis on parent_side.')

    # C-clip collars opening away from child_side (-X in c_world), with chamfered end rims so collars glide cleanly on arms.
    tangent = math.tan(math.radians(opening_deg / 2.0))
    span = outer + 6.0
    collars = []
    for sign in (1.0, -1.0):
        a, b = sorted((sign * low, sign * top))
        ring = cylinder('_collar', outer, b - a, (0, 0, (a + b) / 2.0))
        cut(
            ring,
            cylinder('_ring_bore', inner, b - a + 2.0, (0, 0, (a + b) / 2.0)),
            prism('_opening', [(0.0, 0.0), (-span, -span * tangent), (-span, span * tangent)], b - a + 2.0, (0, 0, (a + b) / 2.0)),
        )
        chamfer(ring, 0.35)
        collars.append(ring)
    leaf = box2('_leaf', ((inner + outer) / 2.0, -web_thickness / 2.0, -top + 0.8), (reach_d, web_thickness / 2.0, top - 0.8))
    chamfer(leaf, 0.3)
    join(leaf, collars[0], collars[1])
    join(child, place(leaf, frame(pivot, axis, child_side)))
    require_one_solid(child, 'snap_hinge', 'Bring the child to within reach of the hinge axis on child_side.')

    ax = direction(axis)
    cdir = direction(child_side)
    rev = joint(name or (child.name + 'Hinge'), 'revolute', parent, child, ax, pivot, limits, control)
    snap_dist = outer + post + 1.5
    total_clear = _clear_distance(child, [parent], cdir)
    pull_dist = max(0.0, total_clear - snap_dist)
    steps = [
        step_snap(
            child,
            cdir * snap_dist,
            max_interference_mm=min(2.4, interference + 0.55),
            pull=(cdir * pull_dist) if pull_dist > 0.5 else None,
            mate=parent,
        )
    ]
    return RecipeResult([rev], parts=[], steps=steps)


def ball_socket(
    parent,
    child,
    pivot,
    axis,
    ball_diameter=14,
    clearance=0.36,
    wall=2.6,
    grip=0.85,
    stem_diameter=6,
    stem_width=9.6,
    stem_length=16,
    tilt_axis=None,
    keyed=True,
    slits=None,
    slit_width=1.4,
    limits=(-20, 20),
    control=None,
    name=None,
):
    """2-part separate-print slotted compliant ball socket: slotted socket shell on `parent` + ball stem on `child`.

    Slits let the socket petals flex open so the ball snaps in after separate printing.
    `keyed=True` constrains motion to a single revolute tilt axis so Bullet verifies full retention and swing.
    """
    if clearance < 0.3:
        raise ValueError('ball_socket: clearance must be at least 0.3 mm')
    radius = ball_diameter / 2.0
    cavity = radius + clearance
    shell = cavity + wall
    mouth = radius - grip
    stem = stem_diameter / 2.0
    if not (0.55 <= grip <= 1.6):
        raise ValueError('ball_socket: grip must be between 0.55 and 1.6 mm for snap retention')
    edge = math.sqrt(max(0.0, cavity ** 2 - mouth ** 2))
    top = edge + 1.0
    tilt = max(abs(limits[0]), abs(limits[1]))
    if tilt >= 45:
        raise ValueError('ball_socket: limits above +-45 degrees are not supported')
    lean = math.radians(tilt)
    reach_y = stem / math.cos(lean) + top * math.tan(lean) + 0.8
    top_wall = math.sqrt(max(0.0, shell ** 2 - top ** 2))
    if (keyed and reach_y > top_wall - 1.0) or (not keyed and reach_y - 0.3 > mouth):
        raise ValueError(f'ball_socket: stem would hit the mouth at {tilt} degrees; use smaller limits or a bigger ball')
    if keyed and stem_width / 2.0 + 0.35 >= radius - 1.0:
        raise ValueError(f'ball_socket: stem_width {stem_width:.1f} is too wide for a {ball_diameter:.1f} mm ball')
    if stem_length < top + 3.0:
        raise ValueError(f'ball_socket: stem_length must be at least {top + 3.0:.1f} mm to clear the socket')

    slit_count = (2 if keyed else 4) if slits is None else int(slits)
    if slit_count not in (2, 3, 4, 6):
        raise ValueError('ball_socket: separate-print slotted socket requires 2, 3, 4, or 6 compliance slits')

    base_frame = frame(pivot, axis)
    t_axis = base_frame.x_dir if tilt_axis is None else direction(tilt_axis)
    if abs(t_axis.dot(direction(axis))) > 0.01:
        raise ValueError('ball_socket: tilt_axis must be perpendicular to axis')
    world = frame(pivot, axis, t_axis)
    slot_x = stem_width / 2.0 + 0.31

    def make_opening():
        if keyed:
            return box2('_mouth', (-slot_x, -reach_y, 0.0), (slot_x, reach_y, top + 8.0))
        return cylinder('_mouth', mouth, top + 8.0, (0, 0, (top + 8.0) / 2.0))

    cut(parent, place(sphere('_cavity', cavity), world), place(make_opening(), world))

    body = sphere('_shell', shell)
    cut(
        body,
        box2('_flat_top', (-shell - 2.0, -shell - 2.0, top), (shell + 2.0, shell + 2.0, shell + 2.0)),
        sphere('_shell_cavity', cavity),
        make_opening(),
    )
    # Place compliance slits around the socket rim so petals flex cleanly during snap insertion.
    if keyed and slit_count == 2:
        # Slits along Y (perpendicular to tilt_axis) cut through the two side jaws gripping the ball.
        cut(body, box2('_slit', (-slit_width / 2.0, -shell - 2.0, -radius * 0.3), (slit_width / 2.0, shell + 2.0, top + 2.0)))
    else:
        for index in range(slit_count):
            slit = box2('_slit', (-shell - 2.0, -slit_width / 2.0, -radius * 0.3), (shell + 2.0, slit_width / 2.0, top + 2.0))
            rotate(slit, 'Z', 180.0 * index / slit_count)
            cut(body, slit)
    join(parent, place(body, world))
    require_one_solid(parent, 'ball_socket', f'Make parent overlap the socket shell within {shell:.1f} mm below the pivot.')

    ball = sphere('_ball', radius)
    if keyed:
        blade = box2('_stem', (-stem_width / 2.0, -stem, 0.0), (stem_width / 2.0, stem, stem_length + 1.0))
        chamfer(blade, 0.25)
    else:
        blade = cylinder('_stem', stem, stem_length + 1.0, (0, 0, (stem_length + 1.0) / 2.0))
    join(ball, blade)
    join(child, place(ball, world))
    require_one_solid(child, 'ball_socket', f'Bring child to the stem tip {stem_length:.1f} mm along axis from pivot.')

    ax = direction(axis)
    rev = joint(name or (child.name + 'Ball'), 'revolute', parent, child, t_axis, pivot, limits, control)
    # Snap interference: in keyed mode ball radius vs slot_x or mouth; bound cleanly under 2.4 mm.
    max_int = max(grip, (radius - slot_x) if keyed else grip)
    snap_dist = top + radius + 1.0
    total_clear = _clear_distance(child, [parent], ax)
    pull_dist = max(0.0, total_clear - snap_dist)
    steps = [
        step_snap(
            child,
            ax * snap_dist,
            max_interference_mm=min(2.4, max_int + 0.55),
            pull=(ax * pull_dist) if pull_dist > 0.5 else None,
            mate=parent,
        )
    ]
    return RecipeResult([rev], parts=[], steps=steps)


def turntable_plate(name, pivot, axis, diameter=40, thickness=5, clearance=0.35, standoff=1.0, chamfer_size=0.5):
    """Create a flat-printable round platter blank for `turntable`.

    Its underside sits `standoff + clearance` mm off the parent mounting face at `pivot` along `axis`.
    """
    part = cylinder(name, diameter / 2.0, thickness, (0, 0, standoff + clearance + thickness / 2.0))
    if chamfer_size and chamfer_size > 0:
        chamfer(part, min(float(chamfer_size), thickness * 0.2))
    return place(part, frame(pivot, axis))


def turntable(
    parent,
    child,
    pivot,
    axis,
    thickness=5,
    post_diameter=10,
    cap_overhang=3.5,
    cap_wall=2.5,
    clearance=0.35,
    radial_clearance=0.4,
    standoff=1.0,
    turn=90,
    limits=(-180, 180),
    control=None,
    name=None,
    cap_name=None,
):
    """3-part separate-print turntable: bayonet post on `parent`, flat platter `child`, and quarter-turn center cap."""
    if clearance < 0.3 or radial_clearance < 0.3:
        raise ValueError('turntable: clearance and radial_clearance must be at least 0.3 mm')
    if post_diameter < 7.0:
        raise ValueError('turntable: post_diameter must be at least 7.0 mm')
    if cap_overhang < 2.0:
        raise ValueError('turntable: cap_overhang must be at least 2.0 mm to retain the platter')
    post_r = post_diameter / 2.0
    bore = post_r + radial_clearance
    cap_r = bore + cap_overhang
    base = standoff + clearance
    z_cap = base + thickness + clearance
    c_label = cap_name or (child.name + 'Cap')
    world = frame(pivot, axis)

    cut(child, place(cylinder('_bore', bore, thickness + 4.0, (0, 0, base + thickness / 2.0)), world))
    require_one_solid(child, 'turntable', 'Make the platter wider than the center bore.')

    cutters, cap_local, z_tip, _ = _build_bayonet_tip_and_cap(
        post_r, z_cap, c_label, cap_r, clearance=clearance, turn=turn, cap_wall=cap_wall
    )
    shaft = cylinder('_post', post_r, z_tip + 2.0, (0, 0, (z_tip - 2.0) / 2.0))
    join(shaft, cylinder('_shoulder', bore + 4.0, standoff + 2.0, (0, 0, (standoff - 2.0) / 2.0)))
    for cutter in cutters:
        cut(shaft, cutter)
    join(parent, place(shaft, world))
    cap = place(cap_local, world)

    require_one_solid(parent, 'turntable', 'Put the pivot on the parent surface so the post root embeds into it.')
    require_one_solid(cap, 'turntable', 'Check post_diameter and cap_overhang.')

    ax = direction(axis)
    rev = joint(name or (child.name + 'Turn'), 'revolute', parent, child, ax, pivot, limits, control)
    lock = joint(cap.name + 'Lock', 'fixed', parent, cap, axis=ax, pivot=pivot, retainer='bayonet')
    steps = [
        step_twist(cap, pivot, ax, -turn, pull=ax * _clear_distance(cap, [parent, child], ax)),
        step_translate(child, ax * _clear_distance(child, [parent], ax)),
    ]
    return RecipeResult([rev, lock], parts=[cap], steps=steps, cap=cap, platter=child)


def bearing(
    parent,
    child,
    pivot,
    axis,
    hub_diameter=12,
    flange_overhang=3.0,
    housing_thickness=8.0,
    flange_thickness=2.5,
    clearance=0.35,
    radial_clearance=0.4,
    stem_height=4.0,
    barb=0.95,
    limits=(-180, 180),
    control=None,
    name=None,
    cap_name=None,
):
    """3-part separate-print journal bearing: bored housing `parent`, flanged rotor `child`, and keyed snap retainer cap.

    `pivot` is the centre of the housing along `axis`; `child` sits on the `+axis` side and extends its shaft
    through the bore in `parent`. The separate keyed retainer cap snaps onto the split-barbed `-axis` tip of
    the shaft (`retainer='snap'`), so it rotates with the rotor in both directions and can never unscrew.
    """
    if clearance < 0.3 or radial_clearance < 0.3:
        raise ValueError('bearing: clearance and radial_clearance must be at least 0.3 mm')
    if hub_diameter < 7.0:
        raise ValueError('bearing: hub_diameter must be at least 7.0 mm')
    if flange_overhang < 2.0 or flange_thickness < 1.6 or housing_thickness < 4.0:
        raise ValueError('bearing: need flange_overhang >= 2.0, flange_thickness >= 1.6, housing_thickness >= 4.0')
    if not (0.7 <= barb <= 1.6):
        raise ValueError('bearing: barb must be between 0.7 and 1.6 mm')

    shaft_r = hub_diameter / 2.0
    bore = shaft_r + radial_clearance
    flange_r = bore + flange_overhang
    half = housing_thickness / 2.0
    z_top_flange_lo = half + clearance
    z_top_flange_hi = z_top_flange_lo + flange_thickness

    # Keyed snap stub extending past the -Z face of the housing (built in +Z and flipped 180 deg about Y).
    stub_r = min(shaft_r - 1.2, shaft_r - barb - clearance - 0.15)
    stub_r = max(2.4, stub_r)
    z_cap_pos = half + clearance
    c_label = cap_name or (child.name + 'Cap')
    world = frame(pivot, axis)
    cut(parent, place(_chamfered_bore(bore, -half, half, lead=0.4), world))
    require_one_solid(parent, 'bearing', 'Make the housing solid around the bore across housing_thickness.')

    tip_solid, slot_cutter, cap_local, _, snap_dist = _build_keyed_snap_tip_and_cap(
        stub_r, z_cap_pos, c_label, flange_r, cap_thick=4.0, clearance=clearance, barb=barb, head_height=2.4
    )
    rotate(tip_solid, 'Y', 180.0)
    rotate(slot_cutter, 'Y', 180.0)
    rotate(cap_local, 'Y', 180.0)

    rotor = cylinder('_shaft', shaft_r, z_top_flange_hi - (-half), (0, 0, (-half + z_top_flange_hi) / 2.0))
    join(
        rotor,
        cylinder('_top_flange', flange_r, flange_thickness, (0, 0, (z_top_flange_lo + z_top_flange_hi) / 2.0)),
        cylinder('_stem', max(3.0, shaft_r * 0.7), stem_height + 1.5, (0, 0, z_top_flange_hi - 1.0 + (stem_height + 1.5) / 2.0)),
        tip_solid,
    )
    cut(rotor, slot_cutter)

    join(child, place(rotor, world))
    cap = place(cap_local, world)
    require_one_solid(child, 'bearing', f'Make the child overlap the rotor stem rising {stem_height:.1f} mm above the top flange.')
    require_one_solid(cap, 'bearing', 'Check hub_diameter and flange_overhang.')

    ax = direction(axis)
    cap_piv = tuple(world.to_world((0, 0, -(z_cap_pos + 2.0))))
    rev = joint(name or (child.name + 'Bearing'), 'revolute', parent, child, ax, pivot, limits, control)
    lock = joint(cap.name + 'Lock', 'fixed', child, cap, pivot=cap_piv, retainer='snap')

    cap_clear = _clear_distance(cap, [parent, child], -ax)
    cap_pull = max(0.0, cap_clear - snap_dist)
    steps = [
        step_snap(
            cap,
            (-ax) * snap_dist,
            max_interference_mm=min(2.4, barb + 0.55),
            pull=((-ax) * cap_pull) if cap_pull > 0.5 else None,
            mate=child,
        ),
        step_translate(child, ax * _clear_distance(child, [parent], ax)),
    ]
    return RecipeResult([rev, lock], parts=[cap], steps=steps, cap=cap, rotor=child)
