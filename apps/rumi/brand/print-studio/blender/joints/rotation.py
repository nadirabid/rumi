"""Rotation recipes: clip hinge, living hinge, ball socket, turntable, journal bearing.

Kit names (cylinder, cut, join, frame, place, joint, ...) are injected by rumi_joints.
"""
import math


def clip_hinge(parent, child, pivot, axis, parent_side, child_side, length=22, post_diameter=6, collar_height=9,
               wall=2.0, clearance=0.4, radial_clearance=0.4, opening_deg=90, arm_thickness=3, reach=None,
               web_thickness=3, limits=(-90, 90), control=None, name=None):
    """Captive C-collar hinge: a post held between two arms grows out of `parent`; `child` gets two open C collars round the post.

    pivot: centre of the hinge on its axis. axis: hinge line. parent_side / child_side: directions perpendicular to
    the axis from the axis toward the material of each part (they must differ). length: free space along the axis
    between the two arm faces; the child must stay within +-(length/2 - clearance) of the pivot along the axis.
    Each part must reach to within `reach` mm of the axis on its side (default: collar radius + 4); the recipe adds
    arms to the parent and a leaf to the child that far and fuses them in.
    The C opens away from child_side and is narrower than the post, so the collars cannot slip off sideways, and the arms
    stop them sliding along the post. The post is fused to the parent: it prints assembled (print-in-place).
    radial_clearance is the loose gap round the post; clearance is the axial gap at each arm face.
    Returns the revolute joint record. Positive angles turn `child` counter-clockwise about `axis`.
    """
    post = post_diameter / 2
    inner = post + radial_clearance
    outer = inner + wall
    half = length / 2
    top = half - clearance
    low = top - collar_height
    if low < 0:
        raise ValueError('clip_hinge: collar_height %.1f does not fit in length %.1f; lengthen the hinge or shorten the collars' % (collar_height, length))
    if not 40 <= opening_deg <= 150:
        raise ValueError('clip_hinge: opening_deg must be between 40 and 150')
    chord = 2 * inner * math.sin(math.radians(opening_deg / 2))
    if chord > post_diameter - 0.4:
        raise ValueError('clip_hinge: the C opening (%.1f mm) is not narrower than the post (%.1f mm); reduce opening_deg or radial_clearance' % (chord, post_diameter))
    if direction(parent_side).dot(direction(child_side)) > 0.7:
        raise ValueError('clip_hinge: parent_side and child_side must point to different sides of the axis')
    reach = reach if reach is not None else outer + 4
    arm_width = post_diameter + 4

    arms = []
    for sign in (1, -1):
        a, b = sorted((sign * half, sign * (half + arm_thickness)))
        arms.append(box2('_arm', (-post - 2, -arm_width / 2, a), (reach, arm_width / 2, b)))
    shaft = cylinder('_post', post, 2 * (half + arm_thickness) - 1.0)
    join(arms[0], arms[1], shaft)
    join(parent, place(arms[0], frame(pivot, axis, parent_side)))
    require_one_solid(parent, 'clip_hinge', 'Bring the parent to within reach of the hinge axis on parent_side so the arms fuse into it.')

    tangent = math.tan(math.radians(opening_deg / 2))
    span = outer + 6
    collars = []
    for sign in (1, -1):
        a, b = sorted((sign * low, sign * top))
        ring = cylinder('_collar', outer, b - a, (0, 0, (a + b) / 2), segments=96)
        cut(ring, cylinder('_ring_bore', inner, b - a + 2, (0, 0, (a + b) / 2), segments=96),
            prism('_opening', [(0, 0), (-span, -span * tangent), (-span, span * tangent)], b - a + 2, (0, 0, (a + b) / 2)))
        collars.append(ring)
    leaf = box2('_leaf', ((inner + outer) / 2, -web_thickness / 2, -top), (reach, web_thickness / 2, top))
    join(leaf, collars[0], collars[1])
    join(child, place(leaf, frame(pivot, axis, child_side)))
    require_one_solid(child, 'clip_hinge', 'Bring the child to within reach of the hinge axis on child_side so the leaf fuses into it.')
    return joint(name or child.name + 'Hinge', 'revolute', parent, child, direction(axis), pivot, limits, control)


def living_hinge(name, pivot, axis, across='X', panel_width=18, panel_thickness=3, length=30, web_thickness=0.5, web_length=2):
    """Make one part: two flat panels joined by a thin flexing web. Returns the part; it has no joint.

    pivot: centre of the web on the face the panels fold away from. axis: hinge line (the part is `length` long
    along it). across: direction from the hinge toward one panel; the other panel goes the opposite way. The panels
    are `panel_thickness` thick toward axis x across, and 45 degree reliefs on that side let them fold toward each
    other. For PP, PETG or TPU printed flat; PLA cracks. A single solid cannot move in Rumi's physics check, so
    publish it as a plain part with no joint.
    """
    half = web_length / 2
    relief = panel_thickness - web_thickness
    if relief < 0.5:
        raise ValueError('living_hinge: panel_thickness must be at least 0.5 mm more than web_thickness')
    if web_thickness < 0.4:
        raise ValueError('living_hinge: web_thickness under 0.4 mm is thinner than two print layers')
    if panel_width < half + relief + 1:
        raise ValueError('living_hinge: panel_width %.1f is too small for the relief; use at least %.1f' % (panel_width, half + relief + 1))
    outline = [(-panel_width, 0), (panel_width, 0), (panel_width, panel_thickness), (half + relief, panel_thickness),
               (half, web_thickness), (-half, web_thickness), (-half - relief, panel_thickness), (-panel_width, panel_thickness)]
    return prism(name, outline, length, pivot, axis, across)


def ball_socket(parent, child, pivot, axis, ball_diameter=12, clearance=0.4, wall=2.5, grip=0.8, stem_diameter=6,
                stem_width=8.6, stem_length=14, tilt_axis=None, keyed=True, slits=0, slit_width=1.2, limits=(-20, 20),
                control=None, name=None):
    """Captive ball joint: a socket shell wrapping more than half the ball grows out of `parent`; `child` gets the ball on a stem.

    pivot: centre of the ball. axis: direction the stem points, out of the socket mouth. The parent must have
    material up to the shell's far side (about ball_diameter/2 + clearance + wall below the pivot, opposite the
    axis); the recipe clears the cavity and mouth out of it. The child must reach the stem tip at
    stem_length from the pivot along the axis; the ball and stem are fused to it.
    The mouth is narrower than the ball (grip mm on the radius), so the ball cannot leave.
    keyed=True (default): the stem is a blade stem_width wide (along tilt_axis) and stem_diameter thick, and the mouth is a
    slot just wider than the blade. Only the tilt about tilt_axis is free, which is what Rumi's checker (revolute joints
    only) can verify. keyed=False: round stem and round mouth; the ball swivels freely in every direction, and the checker's
    off-axis retention probes will report it as unretained.
    tilt_axis: direction perpendicular to axis (default: the frame's X for this axis). slits=0 keeps the shell solid for
    print-in-place; slits=N (2 to 8) adds N cuts so the petals can flex (use with keyed=False).
    Returns the revolute joint record.
    """
    radius = ball_diameter / 2
    cavity = radius + clearance
    shell = cavity + wall
    mouth = radius - grip
    stem = stem_diameter / 2
    if grip < 0.5:
        raise ValueError('ball_socket: grip under 0.5 mm will not hold the ball')
    edge = math.sqrt(cavity ** 2 - mouth ** 2)
    top = edge + 1.0
    tilt = max(abs(limits[0]), abs(limits[1]))
    if tilt >= 45:
        raise ValueError('ball_socket: limits above +-45 degrees are not supported')
    lean = math.radians(tilt)
    reach_y = stem / math.cos(lean) + top * math.tan(lean) + 0.8
    top_wall = math.sqrt(shell ** 2 - top ** 2)
    if (keyed and reach_y > top_wall - 1.2) or (not keyed and reach_y - 0.3 > mouth):
        raise ValueError('ball_socket: the stem would hit the mouth at %d degrees; use a thinner stem, smaller limits or a bigger ball' % tilt)
    if keyed and stem_width / 2 + 0.35 >= radius - 1:
        raise ValueError('ball_socket: stem_width %.1f is too wide for a %.1f mm ball' % (stem_width, ball_diameter))
    if stem_length < top + 3:
        raise ValueError('ball_socket: stem_length must be at least %.1f mm to clear the socket' % (top + 3))
    if slits not in (0, 2, 3, 4, 5, 6, 7, 8):
        raise ValueError('ball_socket: slits must be 0 or 2 to 8')
    if tilt_axis is None:
        tilt_axis = tuple(frame(pivot, axis).col[0].xyz)
    if abs(direction(tilt_axis).dot(direction(axis))) > 0.01:
        raise ValueError('ball_socket: tilt_axis must be perpendicular to axis')
    world = frame(pivot, axis, tilt_axis)
    slot_x = stem_width / 2 + 0.35

    def opening(name):
        if keyed:
            return box2(name, (-slot_x, -reach_y, 0), (slot_x, reach_y, top + 8))
        return cylinder(name, mouth, top + 8, (0, 0, (top + 8) / 2))

    cut(parent, place(sphere('_cavity', cavity, segments=64), world), place(opening('_mouth'), world))

    body = sphere('_shell', shell, segments=64)
    cut(body, box2('_flat_top', (-shell - 2, -shell - 2, top), (shell + 2, shell + 2, shell + 2)),
        sphere('_shell_cavity', cavity, segments=64), opening('_shell_mouth'))
    for index in range(slits):
        slit = box2('_slit', (-shell - 2, -slit_width / 2, -radius * 0.4), (shell + 2, slit_width / 2, top + 2))
        rotate(slit, 'Z', 180 * index / slits)
        cut(body, slit)
    join(parent, place(body, world))
    require_one_solid(parent, 'ball_socket', 'Make the parent reach the socket shell: put material within %.1f mm of the pivot on the side away from axis.' % shell)

    ball = sphere('_ball', radius, segments=64)
    if keyed:
        blade = box2('_stem', (-stem_width / 2, -stem, 0), (stem_width / 2, stem, stem_length + 1))
    else:
        blade = cylinder('_stem', stem, stem_length + 1, (0, 0, (stem_length + 1) / 2))
    join(ball, blade)
    join(child, place(ball, world))
    require_one_solid(child, 'ball_socket', 'Bring the child to the stem tip, stem_length mm from the pivot along axis.')
    return joint(name or child.name + 'Ball', 'revolute', parent, child, direction(tilt_axis), pivot, limits, control)


def turntable_plate(name, pivot, axis, diameter=40, thickness=4, clearance=0.4, standoff=1.0):
    """Make a round platter blank for `turntable`: its underside sits `standoff + clearance` mm off the mounting face at `pivot`.

    `axis` points away from the parent.
    """
    part = cylinder(name, diameter / 2, thickness, (0, 0, standoff + clearance + thickness / 2), segments=96)
    return place(part, frame(pivot, axis))


def turntable(parent, child, pivot, axis, thickness=4, post_diameter=10, head_overhang=3.5, head_height=3,
              clearance=0.4, radial_clearance=0.7, standoff=1.0, limits=(-180, 180), control=None, name=None):
    """Captive turntable: a post with an integral flange head grows out of `parent`; `child` is a platter bored over the post.

    pivot: point on the parent's mounting face where the post starts. axis: direction pointing away from the parent.
    child: a platter occupying standoff + clearance .. standoff + clearance + thickness along the axis (see
    `turntable_plate`); the recipe bores it. standoff is the thickness of a shoulder disc the recipe adds so the
    platter rests on a flat ring. The flange head is wider than the bore, so the platter cannot lift off; there is
    no separate cap, and the whole thing prints assembled (print-in-place).
    radial_clearance is the loose gap round the post; clearance is the gap above and below the platter.
    Returns the revolute joint record.
    """
    post = post_diameter / 2
    bore = post + radial_clearance
    head = bore + head_overhang
    base = standoff + clearance
    plate_top = base + thickness
    head_low = plate_top + clearance
    if head_overhang < 2:
        raise ValueError('turntable: head_overhang under 2 mm is too narrow to hold the platter')
    if head_height < 1.5:
        raise ValueError('turntable: head_height under 1.5 mm is too thin')
    world = frame(pivot, axis)

    cut(child, place(cylinder('_bore', bore, thickness + 4, (0, 0, base + thickness / 2), segments=96), world))

    shaft = cylinder('_post', post, head_low + 1.0 + 2, (0, 0, (head_low + 1.0 - 2) / 2), segments=96)
    join(shaft, cylinder('_shoulder', bore + 4, standoff + 2, (0, 0, (standoff - 2) / 2), segments=96))
    join(shaft, cylinder('_head', head, head_height, (0, 0, head_low + head_height / 2), segments=96))
    join(parent, place(shaft, world))
    require_one_solid(parent, 'turntable', 'Put the pivot on the parent surface so the post root is embedded in it.')
    return joint(name or child.name + 'Turn', 'revolute', parent, child, direction(axis), pivot, limits, control)


def bearing(parent, child, pivot, axis, hub_diameter=16, flange_overhang=3, lip_height=3, flange_thickness=2.5,
            clearance=0.4, radial_clearance=0.6, stem_height=4, limits=(-180, 180), control=None, name=None):
    """Captive journal bearing: the bore is cut into `parent` as a lip; `child` gets a spool whose flanges trap that lip.

    pivot: centre of the bearing on its axis. axis: rotation axis; child sits on its + side. The parent must be solid
    around the pivot across the bearing thickness, lip_height + 2 * (clearance + flange_thickness) centred on the
    pivot along the axis (the flanges end flush with its faces). The spool's stem rises `stem_height` mm above the top flange;
    the child's underside must lie 1-3 mm above the bearing top so the stem fuses into it.
    There are no rolling balls: the surfaces slide on each other. Balls or rollers would each be a separate part that
    Rumi cannot check, so they are not offered.
    Returns the revolute joint record.
    """
    neck = hub_diameter / 2
    flange = neck + flange_overhang
    thick = lip_height + 2 * (clearance + flange_thickness)
    half = thick / 2
    lip = lip_height / 2
    inside = lip + clearance
    if flange_overhang < 2:
        raise ValueError('bearing: flange_overhang under 2 mm will not hold the child in')
    if flange_thickness < 1.6:
        raise ValueError('bearing: flange_thickness under 1.6 mm is too thin')
    if lip_height < 1.6:
        raise ValueError('bearing: lip_height under 1.6 mm is too thin')
    world = frame(pivot, axis)

    far = half + stem_height + 6
    cut(parent,
        place(cylinder('_lip_bore', neck + radial_clearance, 2 * far, segments=96), world),
        place(cylinder('_upper', flange + radial_clearance, far - lip, (0, 0, (far + lip) / 2), segments=96), world),
        place(cylinder('_lower', flange + radial_clearance, far - lip, (0, 0, -(far + lip) / 2), segments=96), world))
    require_one_solid(parent, 'bearing', 'Make the parent solid across the bearing thickness around the pivot; the lip must stay attached to it.')

    spool = lathe('_spool', [(0, -half), (flange, -half), (flange, -inside), (neck, -inside), (neck, inside),
                             (flange, inside), (flange, half), (0, half)], segments=96)
    join(spool, cylinder('_stem', neck * 0.6, stem_height + 1, (0, 0, half - 1 + (stem_height + 1) / 2), segments=96))
    join(child, place(spool, world))
    require_one_solid(child, 'bearing', 'Make the child overlap the spool stem, which rises %.1f mm above the bearing top.' % stem_height)
    return joint(name or child.name + 'Bearing', 'revolute', parent, child, direction(axis), pivot, limits, control)
