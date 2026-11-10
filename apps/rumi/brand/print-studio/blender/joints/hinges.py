"""Hinge recipes. Kit names (cylinder, cut, join, frame, place, joint, ...) are injected by rumi_joints."""


def barrel_hinge(parent, child, pivot, axis, parent_side, child_side, length=30, knuckle_diameter=12, pin_diameter=4,
                 reach=None, web_thickness=None, clearance=0.3, pin_clearance=0.7, barrel_fraction=0.5,
                 limits=(0, 110), control=None, name=None):
    """Captive barrel hinge: two outer knuckles and the pin are part of `parent`; `child` gets the centre knuckle around the pin.

    pivot: centre of the hinge on its axis. axis: hinge line. parent_side / child_side: directions from the axis
    toward the material of each part in the saved (closed) pose. Each part must reach to within `reach` mm of the
    axis on its side (default knuckle radius + 3); the recipe adds a web that far and fuses it in.
    Nothing but the webs and knuckles may sit within the knuckle radius + clearance of the axis.
    The pin is fused to the parent, so the hinge prints assembled (print-in-place) and cannot come apart.
    clearance is the axial gap at each knuckle face; pin_clearance is the looser radial gap round the pin, which lets
    the flat knuckle faces, not the bore edges, carry a side-hung door.
    Returns the revolute joint record. Positive angles turn `child` counter-clockwise about `axis`.
    """
    radius = knuckle_diameter / 2
    pin = pin_diameter / 2
    if radius - pin - pin_clearance < 1.2:
        raise ValueError('barrel_hinge: knuckle wall would be under 1.2 mm; use a larger knuckle_diameter or smaller pin_diameter')
    reach = reach if reach is not None else radius + 3
    thick = web_thickness if web_thickness is not None else min(knuckle_diameter, 4)
    centre = length * barrel_fraction
    outer = (length - centre - 2 * clearance) / 2
    if outer < 1.6:
        raise ValueError('barrel_hinge: length %.1f is too short; use at least 14 mm' % length)

    def knuckle(low, high, side):
        barrel = cylinder('_knuckle', radius, high - low, (0, 0, (low + high) / 2))
        web = box2('_web', (0, -thick / 2, low), (reach, thick / 2, high))
        join(barrel, web)
        return place(barrel, frame(pivot, axis, side))

    half = centre / 2
    middle = knuckle(-half, half, child_side)
    cut(middle, place(cylinder('_bore', pin + pin_clearance, centre + 4), frame(pivot, axis, child_side)))
    join(child, middle)

    low, high = half + clearance, half + clearance + outer
    upper, lower = knuckle(low, high, parent_side), knuckle(-high, -low, parent_side)
    shaft = place(cylinder('_pin', pin, length - 2), frame(pivot, axis, parent_side))
    join(upper, shaft)
    join(upper, lower)
    join(parent, upper)

    require_one_solid(parent, 'barrel_hinge', 'Bring the parent to within reach of the hinge axis on parent_side.')
    require_one_solid(child, 'barrel_hinge', 'Bring the child to within reach of the hinge axis on child_side.')
    return joint(name or child.name + 'Hinge', 'revolute', parent, child, direction(axis), pivot, limits, control)
