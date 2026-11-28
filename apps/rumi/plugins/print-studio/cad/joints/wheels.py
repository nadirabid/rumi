"""Separate-print wheel and axle recipes built on build123d B-Rep.

Kit names (box, cylinder, prism, lathe, cut, join, chamfer, frame, place, joint, step_translate,
step_twist, step_snap, RecipeResult, ...) are injected by `cad/rumi_joints.py`.
"""


def _rib_ring(part, radius, width, centre_z, count, rib_height=1.6, rib_width=None):
    """Fuse `count` flat-safe radial grip ribs around a wheel centred at `centre_z` along local Z."""
    w = rib_width if rib_width is not None else max(1.8, radius * 0.14)
    h = max(1.0, width - 1.6)
    for index in range(count):
        rib = box('_rib', (rib_height + 1.0, w, h), (radius + (rib_height - 1.0) / 2.0, 0, centre_z))
        rotate(rib, 'Z', 360.0 * index / count)
        join(part, rib)


def wheel(name, pivot, axis, diameter=30, width=10, end_play=0.35, tread=0, standoff=1.0, chamfer_size=0.5):
    """Create a flat-printable wheel blank whose inner face sits `standoff + end_play` mm off `pivot` along `axis`.

    Ready for `bayonet_axle` or `snap_axle`. `tread > 0` adds inset radial grip ribs so both faces stay flat.
    """
    radius = diameter / 2.0
    if radius < 6.0 or width < 4.0:
        raise ValueError('wheel: use diameter >= 12 mm and width >= 4 mm')
    z_mid = standoff + end_play + width / 2.0
    part = cylinder(name, radius, width, (0, 0, z_mid))
    if chamfer_size and chamfer_size > 0:
        c = min(float(chamfer_size), width * 0.2, radius * 0.15)
        chamfer(part, c)
    if tread:
        _rib_ring(part, radius, width, z_mid, int(tread))
    placed = place(part, frame(pivot, axis))
    placed['rumi_wheel_blank'] = round(volume(placed), 3)
    return placed


def bayonet_axle(
    parent,
    child,
    pivot,
    axis,
    width=10,
    axle_diameter=8,
    clearance=0.35,
    end_play=0.35,
    standoff=1.0,
    cap_diameter=None,
    lug_height=2.2,
    lip_height=2.2,
    cap_wall=2.4,
    turn=90,
    recess=None,
    limits=(-180, 180),
    control=None,
    name=None,
    cap_name=None,
):
    """3-part separate-print stub axle: smooth bayonet axle on `parent`, plain-bore `child` wheel, and quarter-turn hub cap.

    `pivot` sits on the parent mounting face; `axis` points away from the parent through the wheel.
    When `recess=None` (default), wheels with `width >= 8 mm` and enough hub diameter are automatically
    counterbored on the outer face so the locking cap sits compact and nearly flush (leaving ~2.2 mm proud
    to pinch and twist, cutting axle cantilever leverage). Thin or narrow rotors fall back cleanly to
    `recess=False`; pass `recess=True` to require a recessed hub or `recess=False` for an external cap.
    Returns a `RecipeResult` with `.cap`, `.wheel`, `.joints`, `.steps`, and badge evidence.
    """
    if clearance < 0.3 or end_play < 0.3:
        raise ValueError('bayonet_axle: clearance and end_play must be at least 0.3 mm')
    if axle_diameter < 6.0:
        raise ValueError('bayonet_axle: axle_diameter must be at least 6.0 mm for recessed bayonet channels')
    radius = axle_diameter / 2.0
    bore = radius + clearance
    base = standoff + end_play
    seat = base + width
    cap_label = cap_name or (child.name + 'Cap')
    cap_r = (cap_diameter / 2.0) if cap_diameter is not None else max(bore + 2.2, radius + clearance + 2.0)
    # Give the counterbore generous radial clearance around the stationary cap so a tilted spinning wheel
    # never drags or binds against the cap sleeve (retention is carried by the inner hub bearing bore).
    cbore_r = cap_r + max(1.0, clearance * 2.5)

    is_wheel = bool(child.get('rumi_wheel_blank'))
    world = frame(pivot, axis)

    # Determine whether to counterbore the outer wheel face for a compact recessed locking cap.
    cap_height = 0.35 + (clearance + 0.35) + lug_height + clearance + lip_height + clearance + cap_wall
    min_hub = 5.5
    proud_grip = 2.2
    (cx_lo, cx_hi), (cy_lo, cy_hi), _ = _local_extents(child, world)
    child_min_r = min(-cx_lo, cx_hi, -cy_lo, cy_hi)
    if recess is None:
        use_recess = (width >= 8.0) and (child_min_r >= cbore_r + 1.8)
    else:
        use_recess = bool(recess)
        if use_recess:
            if width < min_hub + 2.5:
                raise ValueError(
                    f'bayonet_axle: width {width:.1f} mm is too thin for recess=True; use recess=False or width >= {min_hub + 2.5:.1f} mm'
                )
            if child_min_r < cbore_r + 1.5:
                raise ValueError(
                    f'bayonet_axle: child hub radius {child_min_r:.1f} mm is too narrow for recessed counterbore radius {cbore_r:.1f} mm; use recess=False'
                )

    if use_recess:
        recess_depth = min(cap_height - proud_grip, width - min_hub)
        stop = seat - recess_depth
        z_cap = stop + end_play
        cut(child, place(_chamfered_bore(bore, base, stop, lead=0.25), world))
        cbore_lead = min(0.45, recess_depth * 0.25)
        cbore_profile = [
            (0.0, stop),
            (cbore_r, stop),
            (cbore_r, seat - cbore_lead),
            (cbore_r + cbore_lead, seat),
            (cbore_r + cbore_lead + 1.5, seat + 1.5),
            (0.0, seat + 1.5),
        ]
        cut(child, place(lathe('_cbore', cbore_profile), world))
    else:
        z_cap = seat + end_play
        cut(child, place(_chamfered_bore(bore, base, seat, lead=0.45), world))
    require_one_solid(child, 'bayonet_axle', 'Make the child wider than the bore around the pivot.')

    cutters, cap_local, z_tip, z_outer = _build_bayonet_tip_and_cap(
        radius,
        z_cap,
        cap_label,
        cap_r,
        clearance=clearance,
        turn=turn,
        lug_height=lug_height,
        lip_height=lip_height,
        cap_wall=cap_wall,
    )

    axle = cylinder('_axle', radius, z_tip + 2.0, (0, 0, (z_tip - 2.0) / 2.0))
    if standoff > 0:
        join(axle, cylinder('_shoulder', max(bore + 2.2, cap_r), standoff + 2.0, (0, 0, (standoff - 2.0) / 2.0)))
    for cutter in cutters:
        cut(axle, cutter)
    join(parent, place(axle, world))
    cap = place(cap_local, world)

    require_one_solid(parent, 'bayonet_axle', 'Put the pivot on the parent face so the axle root embeds into it.')
    require_one_solid(cap, 'bayonet_axle', 'Increase cap_diameter or axle_diameter.')

    ax = direction(axis)
    cap_piv = tuple(world.to_world((0, 0, (z_cap + z_outer) / 2.0)))
    rev = joint(name or (child.name + 'Axle'), 'revolute', parent, child, ax, pivot, limits, control)
    lock = joint(cap.name + 'Lock', 'fixed', parent, cap, axis=ax, pivot=cap_piv, retainer='bayonet')

    cap_pull = ax * _clear_distance(cap, [parent, child], ax)
    wheel_pull = ax * _clear_distance(child, [parent], ax)
    steps = [
        step_twist(cap, cap_piv, ax, -turn, pull=cap_pull),
        step_translate(child, wheel_pull),
    ]
    features = [_record_badge_feature('wheel-and-axle', [parent, child, cap], [rev, lock])] if is_wheel else []
    return RecipeResult([rev, lock], parts=[cap], steps=steps, features=features, cap=cap, wheel=child)


def snap_axle(
    parent,
    child,
    pivot,
    axis,
    width=10,
    axle_diameter=8,
    clearance=0.35,
    end_play=0.35,
    barb=1.0,
    head_height=2.6,
    standoff=1.0,
    recess=True,
    limits=(-180, 180),
    control=None,
    name=None,
):
    """2-part separate-print snap axle: split barbed cantilevered stub axle on `parent` + counterbored `child` wheel.

    The split prongs flex inward as the wheel snaps past the barb (`barb` <= 1.8 mm) and lock behind the bore face.
    Returns a `RecipeResult` with declared snap disassembly and badge evidence.
    """
    if clearance < 0.3 or end_play < 0.3:
        raise ValueError('snap_axle: clearance and end_play must be at least 0.3 mm')
    if not (0.7 <= barb <= 1.8):
        raise ValueError('snap_axle: barb must be between 0.7 and 1.8 mm')
    radius = axle_diameter / 2.0
    bore = radius + clearance
    head_r = bore + barb
    base = standoff + end_play
    seat = base + width
    pocket = (head_height + end_play + 0.3) if recess else 0.0
    if recess and width - pocket < 3.0:
        raise ValueError(f'snap_axle: width {width:.1f} is too thin for a recessed head; use recess=False or width >= {pocket + 3.0:.1f}')
    stop = seat - pocket
    top = stop + end_play
    is_wheel = bool(child.get('rumi_wheel_blank'))
    world = frame(pivot, axis)

    cut(child, place(_chamfered_bore(bore, base, stop, lead=0.4), world))
    if recess:
        cut(child, place(cylinder('_cbore', head_r + clearance, pocket + 2.0, (0, 0, stop + (pocket + 2.0) / 2.0)), world))
    require_one_solid(child, 'snap_axle', 'Make the wheel hub thicker or wider around the bore.')

    axle = cylinder('_axle', radius, top + 2.5, (0, 0, (top - 2.0) / 2.0))
    if standoff > 0:
        join(axle, cylinder('_shoulder', head_r + 2.0, standoff + 2.0, (0, 0, (standoff - 2.0) / 2.0)))
    lead_z = max(0.7, head_height - 1.1)
    head = lathe('_head', [
        (0.0, top),
        (head_r, top),
        (head_r, top + head_height - lead_z),
        (radius - 0.15, top + head_height),
        (0.0, top + head_height),
    ])
    join(axle, head)
    slot_w = max(1.6, radius * 0.45)
    slot_d = head_height + max(3.5, width * 0.55)
    slot = box('_slot', (head_r * 2.0 + 3.0, slot_w, slot_d + 1.0), (0, 0, top + head_height - (slot_d - 1.0) / 2.0))
    cut(axle, slot)
    join(parent, place(axle, world))
    require_one_solid(parent, 'snap_axle', 'Put the pivot on the parent surface so the axle root embeds into it.')

    ax = direction(axis)
    rev = joint(name or (child.name + 'Axle'), 'revolute', parent, child, ax, pivot, limits, control)
    snap_dist = (top + head_height) - base + 0.8
    total_clear = _clear_distance(child, [parent], ax)
    pull_dist = max(0.0, total_clear - snap_dist)
    steps = [
        step_snap(
            child,
            ax * snap_dist,
            max_interference_mm=min(2.4, barb + 0.5),
            pull=(ax * pull_dist) if pull_dist > 0.5 else None,
            mate=parent,
        )
    ]
    features = [_record_badge_feature('wheel-and-axle', [parent, child], [rev])] if is_wheel else []
    return RecipeResult([rev], parts=[], steps=steps, features=features, wheel=child)


def through_axle(
    parent,
    child,
    pivot,
    axis,
    body_width,
    axle_diameter=8.5,
    wheel_diameter=30,
    wheel_width=8,
    clearance=0.35,
    end_play=0.35,
    standoff=1.0,
    tread=0,
    turn=90,
    limits=(-180, 180),
    control=None,
    name=None,
):
    """3-part separate-print through-axle: keyed wheel-and-axle unit + separate keyed second wheel + keyed snap hub cap.

    Both wheels turn together on one double-D axle rod through a smooth bore in `parent`.
    Every piece prints flat with zero print-in-place trapping: drop the axle unit through the body
    from `-axis`, slide the second wheel onto the keyed `+axis` shaft, and snap the keyed hub cap onto the tip.
    `child` is a base name string (creates `<child>`, `<child>Right`, `<child>Cap`).
    """
    if not isinstance(child, str) or not child.strip():
        raise ValueError('through_axle: child must be a base name string for the separate axle, wheel, and cap')
    if clearance < 0.3 or end_play < 0.3:
        raise ValueError('through_axle: clearance and end_play must be at least 0.3 mm')
    if axle_diameter < 7.5:
        raise ValueError('through_axle: axle_diameter must be at least 7.5 mm for keyed separate-print snap tip')
    if body_width < 4.0:
        raise ValueError(f'through_axle: body_width {body_width:.1f} is too thin (need >= 4 mm)')
    radius = axle_diameter / 2.0
    bore = radius + clearance
    if wheel_diameter / 2.0 < bore + 3.0:
        raise ValueError(f'through_axle: wheel_diameter {wheel_diameter:.1f} is too small; use at least {2 * bore + 6:.1f}')

    flat_half = radius - 0.85
    tip_r = flat_half - 0.05
    half = body_width / 2.0
    z_wheel_in = half + standoff + end_play
    z_wheel_out = z_wheel_in + wheel_width
    z_cap = z_wheel_out + end_play
    cap_r = max(bore + 2.2, radius + clearance + 2.0)

    world = frame(pivot, axis)
    # Bearing rings + smooth round through-bore on parent.
    for sign in (1.0, -1.0):
        ring = cylinder('_ring', bore + 2.8, standoff + 1.5, (0, 0, sign * (half + (standoff - 1.5) / 2.0)))
        join(parent, place(ring, world))
    cut(parent, place(_chamfered_bore(bore, -(half + standoff), +(half + standoff), lead=0.45), world))
    require_one_solid(parent, 'through_axle', 'Keep body_width no larger than the parent thickness at the pivot.')

    # Build keyed snap tip and retainer cap for the +axis end (full 6-DOF locked so it never unscrews during rotation).
    # Keep barb head_r = snap_stub_r + clearance + barb < bore so the right wheel slides straight over the tip.
    snap_barb = 0.85
    snap_stub_r = min(flat_half - 0.15, bore - clearance - snap_barb - 0.10)
    tip_solid, slot_cutter, cap_pos_local, z_tip, snap_dist = _build_keyed_snap_tip_and_cap(
        snap_stub_r, z_cap, child + 'Cap', cap_r, cap_thick=3.8, clearance=clearance, barb=snap_barb, head_height=2.2
    )

    # Part 1: left wheel fused integrally to the double-D axle rod + right keyed snap tip (prints flat on left wheel face).
    z_dd_end = z_wheel_out - 0.35
    z_left_mid = -(z_wheel_in + wheel_width / 2.0)
    axle_local = cylinder(child, wheel_diameter / 2.0, wheel_width, (0, 0, z_left_mid))
    chamfer(axle_local, min(0.5, wheel_width * 0.15))
    if tread:
        _rib_ring(axle_local, wheel_diameter / 2.0, wheel_width, z_left_mid, int(tread))
    join(
        axle_local,
        _double_d_prism('_shaft', radius, flat_half, z_dd_end - (-z_wheel_in - 1.0), (z_dd_end + (-z_wheel_in - 1.0)) / 2.0),
        tip_solid,
    )
    cut(axle_local, slot_cutter)

    axle = place(axle_local, world)
    cap_right = place(cap_pos_local, world)

    # Part 2: separate flat-printable right wheel with keyed double-D bore.
    z_right_mid = z_wheel_in + wheel_width / 2.0
    wheel_right_local = cylinder(child + 'Right', wheel_diameter / 2.0, wheel_width, (0, 0, z_right_mid))
    chamfer(wheel_right_local, min(0.5, wheel_width * 0.15))
    if tread:
        _rib_ring(wheel_right_local, wheel_diameter / 2.0, wheel_width, z_right_mid, int(tread))
    dd_bore = _double_d_prism('_dd_bore', bore, flat_half + clearance, wheel_width + 4.0, z_right_mid)
    cut(wheel_right_local, dd_bore)
    wheel_right = place(wheel_right_local, world)

    for p in (axle, wheel_right, cap_right):
        require_one_solid(p, 'through_axle', 'Check axle_diameter and wheel_diameter proportions.')

    ax = direction(axis)
    wr_piv = tuple(world.to_world((0, 0, z_right_mid)))
    cap_piv = tuple(world.to_world((0, 0, z_cap + 1.9)))
    j_axle = joint(name or (child + 'Axle'), 'revolute', parent, axle, ax, pivot, limits, control)
    j_wr = joint(wheel_right.name + 'Key', 'fixed', axle, wheel_right, pivot=wr_piv, retainer='rigid')
    j_cr = joint(cap_right.name + 'Lock', 'fixed', axle, cap_right, pivot=cap_piv, retainer='snap')

    # Disassembly: snap off cap (+axis), slide off right wheel (+axis), then slide axle+left wheel out (-axis).
    all_parts = [parent, axle, wheel_right, cap_right]
    cap_clear = _clear_distance(cap_right, all_parts, ax)
    cap_pull = max(0.0, cap_clear - snap_dist)
    steps = [
        step_snap(cap_right, ax * snap_dist, max_interference_mm=min(2.4, snap_barb + 0.55), pull=(ax * cap_pull) if cap_pull > 0.5 else None, mate=axle),
        step_translate(wheel_right, ax * _clear_distance(wheel_right, [parent, axle], ax)),
        step_translate(axle, (-ax) * _clear_distance(axle, [parent], -ax)),
    ]
    all_joints = [j_axle, j_wr, j_cr]
    features = [_record_badge_feature('wheel-and-axle', all_parts, all_joints)]
    return RecipeResult(
        all_joints,
        parts=[axle, wheel_right, cap_right],
        steps=steps,
        features=features,
        axle=axle,
        wheel_right=wheel_right,
        cap=cap_right,
    )


def _pegged_disc(name, radius, thickness, pegs, peg_radius, height):
    """Disc of `radius` and `thickness` along Z with `pegs` radial round drive pegs."""
    disc = cylinder(name, radius, thickness)
    for index in range(pegs):
        peg = cylinder('_peg', peg_radius, height + 1.0, (radius + (height - 1.0) / 2.0, 0, 0), 'X')
        rotate(peg, 'Z', 360.0 * index / pegs)
        join(disc, peg)
    return disc


def tyre(
    parent,
    child,
    pivot,
    axis,
    hub_diameter,
    width,
    tyre_diameter=None,
    flange=2.0,
    rim_depth=2.0,
    gap=0.3,
    pegs=6,
    peg_diameter=3.5,
    peg_clearance=0.35,
    tread=20,
    tread_height=1.5,
    name=None,
):
    """Separate TPU tyre seated in a keyed rim channel cut round `parent` (the rigid hub).

    Prints flat as a separate elastic ring and stretches over the rim flange (`rim_depth <= 2.2 mm`).
    Returns a `RecipeResult` with fixed `retainer='snap'` and verified snap disassembly.
    """
    if not isinstance(child, str) or not child.strip():
        raise ValueError('tyre: child must be a name string; the recipe creates the tyre part')
    if gap < 0.3:
        raise ValueError('tyre: gap must be at least 0.3 mm')
    outer = hub_diameter / 2.0
    floor = outer - rim_depth
    channel = width - 2.0 * flange
    if channel < 4.0 or floor < 6.0 or not (1.4 <= rim_depth <= 2.2):
        raise ValueError(
            f'tyre: need channel >= 4 mm, floor radius >= 6 mm, and rim_depth in 1.4..2.2 mm (got channel={channel:.1f}, floor={floor:.1f}, rim_depth={rim_depth:.1f})'
        )
    tyre_outer = (tyre_diameter if tyre_diameter is not None else hub_diameter + 8.0) / 2.0
    body_outer = tyre_outer - (tread_height if tread else 0.0)
    if body_outer < outer + 1.2:
        raise ValueError('tyre: tyre_diameter must exceed hub_diameter by at least 2.4 mm plus tread')
    if pegs and (peg_diameter > channel - 2.0 or peg_diameter > rim_depth + 2.0):
        raise ValueError('tyre: peg_diameter is too large for this rim channel')

    world = frame(pivot, axis)
    wide = channel - 2.0 * gap
    peg_height = min(1.3, rim_depth - 0.5)

    trench = cylinder('_trench', outer * 1.15 + 3.0, channel)
    if pegs:
        cut(trench, _pegged_disc('_core', floor, channel + 2.0, pegs, peg_diameter / 2.0, peg_height))
    else:
        cut(trench, cylinder('_core', floor, channel + 2.0))
    cut(parent, place(trench, world))
    # Bevel the inner rim of both hub flanges so the tyre bears on the flat flange wall, not a sharp 90-deg edge.
    bev = 0.45
    for sign in (1.0, -1.0):
        zc = sign * channel / 2.0
        cut(parent, place(lathe('_flange_bev', [
            (outer - bev, zc), (outer + 1.0, zc), (outer + 1.0, zc + sign * bev), (outer, zc + sign * bev),
        ]), world))

    ring = cylinder(child, body_outer, wide)
    for index in range(int(tread)):
        lug = box2('_lug', (body_outer - 0.6, -1.4, -(wide / 2.0 - 0.8)), (tyre_outer, 1.4, wide / 2.0 - 0.8))
        rotate(lug, 'Z', 360.0 * index / tread)
        join(ring, lug)
    if pegs:
        cut(ring, _pegged_disc('_bore', floor + gap, wide + 2.0, pegs, peg_diameter / 2.0 + peg_clearance, peg_height + peg_clearance))
    else:
        cut(ring, cylinder('_bore', floor + gap, wide + 2.0))
    # Chamfer the tyre's inner bore rims so it seats smoothly inside the hub channel without sharp-edge interference.
    for sign in (1.0, -1.0):
        zc = sign * wide / 2.0
        cut(ring, lathe('_tyre_bev', [
            (floor + gap - 0.5, zc + sign * 0.5), (floor + gap + 0.5, zc + sign * 0.5),
            (floor + gap + 0.5, zc), (floor + gap, zc - sign * 0.45), (floor + gap - 0.5, zc - sign * 0.45),
        ]))
    place(ring, world)

    require_one_solid(parent, 'tyre', 'Make the hub a solid disc at least `width` mm thick centred on the pivot.')
    require_one_solid(ring, 'tyre', 'Reduce tread or tread_height.')

    ax = direction(axis)
    seat = joint(name or (child + 'Seat'), 'fixed', parent, ring, retainer='snap')
    snap_dist = width / 2.0 + wide / 2.0 + 1.0
    total_clear = _clear_distance(ring, [parent], ax)
    pull_dist = max(0.0, total_clear - snap_dist)
    steps = [
        step_snap(
            ring,
            ax * snap_dist,
            max_interference_mm=min(2.4, rim_depth + 0.35),
            pull=(ax * pull_dist) if pull_dist > 0.5 else None,
            mate=parent,
        )
    ]
    return RecipeResult([seat], parts=[ring], steps=steps, tyre=ring)
