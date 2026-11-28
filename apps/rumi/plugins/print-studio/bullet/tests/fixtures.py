"""Physical mechanism fixtures shared by native and packaged integration checks."""
import argparse
import copy
import gzip
import json
import math
from pathlib import Path

SETTINGS = dict(maxTotalSteps=2000000, retentionWorkers=2, timeStepSeconds=.00025, iterations=40, probeDurationSeconds=.5,
                restDurationSeconds=.02, retentionDurationSeconds=.05,
                densityKgM3=1250, forceN=1, torqueNm=.05,
                linearToleranceMm=.5, angularToleranceDegrees=3, maxPenetrationMm=.05,
                retentionTravelMm=2, retentionTiltDegrees=15,
                gravityMps2=[0,0,0], friction=0, movementSampleDegrees=45, movementSampleMm=2, assemblySampleMm=.2)


def request(broken=False):
    data = json.loads(gzip.decompress(Path(__file__).with_name('hinge.json.gz').read_bytes()))
    variant = 'broken' if broken else 'normal'
    bodies = []
    for part in ('fixed', 'moving'):
        mesh = data[variant + '-' + part]
        bodies.append(dict(id=part, vertices=[[v * 1000 for v in p] for p in mesh['vertices']], triangles=mesh['faces']))
    return assembly(bodies, 'fixed', [dict(id='hinge', parent='fixed', child='moving', kind='revolute', axis=[1,0,0], pivot=[0,0,.25], range=[-90,0])])


def box(name, center, half):
    vertices = [[center[i] + half[i] * p[i] for i in range(3)] for p in
                [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]]
    triangles = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
    return dict(id=name, vertices=vertices, triangles=triangles)


def assembly(bodies, root, connections):
    return dict(version=2, settings=copy.deepcopy(SETTINGS), bodies=bodies,
                assembly=dict(version=1, root=root, parts=[dict(id=b['id'],mesh=b['id']) for b in bodies],
                              connections=connections, manufacturing=dict(mode='print-in-place')))


def slider(blocked=False):
    # A single closed tube supplies every wall; separate walls would be loose parts.
    vertices=[]
    for x in [-10,10]:
        for radius in [3,2.05]:
            vertices.extend([[x,y*radius,z*radius] for y,z in [(-1,-1),(1,-1),(1,1),(-1,1)]])
    triangles=[]
    def quad(a,b,c,d):triangles.extend([[a,b,c],[a,c,d]])
    for i in range(4):
        j=(i+1)%4
        quad(i,j,8+j,8+i)
        quad(4+j,4+i,12+i,12+j)
        quad(i,4+i,4+j,j)
        quad(8+j,12+j,12+i,8+i)
    frame=dict(id='frame',vertices=vertices,triangles=triangles)
    moving=box('moving',[0,0,0],[2,2,2])
    if blocked:
        # Wider moving geometry cannot fit in the channel.
        moving=box('moving',[0,0,0],[2,2.3,2])
    return assembly([frame,moving], 'frame', [dict(id='slider',parent='frame',child='moving',kind='prismatic',axis=[1,0,0],pivot=[0,0,0],range=[-4,4])])


def revolution(name, profile, segments=64):
    vertices, rings, triangles = [], [], []
    for radius, height in profile:
        ring = []
        for step in range(segments if radius else 1):
            angle = step * 2 * math.pi / segments
            ring.append(len(vertices))
            vertices.append([radius * math.cos(angle), radius * math.sin(angle), height])
        rings.append(ring)
    for index, ring in enumerate(rings):
        following = rings[(index + 1) % len(rings)]
        for step in range(segments):
            a, b = ring[step % len(ring)], ring[(step + 1) % len(ring)]
            c, d = following[(step + 1) % len(following)], following[step % len(following)]
            for face in ([a,b,c], [a,c,d]):
                if len(set(face)) == 3:
                    triangles.append(face)
    return dict(id=name, vertices=vertices, triangles=triangles)


def wheel(play=.3):
    # play is the axial clearance between each axle flange and the wheel hub.
    inner = 4 + play
    bodies = [revolution('axle', [(0,-inner-.7),(9,-inner-.7),(9,-inner),(3.8,-inner),
                                  (3.8,inner),(9,inner),(9,inner+.7),(0,inner+.7)]),
              revolution('wheel', [(4,-4),(12,-4),(12,4),(4,4)])]
    return assembly(bodies,'axle',[dict(id='wheel',parent='axle',child='wheel',kind='revolute',axis=[0,0,1],pivot=[0,0,0],range=[-180,180])])


def two_wheels():
    axle=revolution('axle', [(0,-10),(9,-10),(9,-9.3),(3.8,-9.3),(3.8,-.3),
                              (9,-.3),(9,.3),(3.8,.3),(3.8,9.3),(9,9.3),(9,10),(0,10)],32)
    wheels=[revolution('lower',[(4,-9),(12,-9),(12,-.6),(4,-.6)],32),
            revolution('upper',[(4,.6),(12,.6),(12,9),(4,9)],32)]
    return assembly([axle,*wheels],'axle',[dict(id=b['id'],parent='axle',child=b['id'],kind='revolute',axis=[0,0,1],pivot=[0,0,0],range=[-90,90]) for b in wheels])


def loose_pin():
    value=wheel()
    value['bodies'].insert(0,box('chassis',[30,0,0],[5,5,5]))
    return assembly(value['bodies'],'chassis',[dict(id='pin_mount',parent='chassis',child='axle',kind='fixed'),*value['assembly']['connections']])


def loose_cap():
    bodies=[revolution('axle',[(0,-5),(9,-5),(9,-4.3),(3.8,-4.3),(3.8,5),(0,5)],32),
            revolution('wheel',[(4,-4),(12,-4),(12,4),(4,4)],32),
            revolution('cap',[(3.9,4.3),(9,4.3),(9,5),(3.9,5)],32)]
    return assembly(bodies,'axle',[dict(id='wheel',parent='axle',child='wheel',kind='revolute',axis=[0,0,1],pivot=[0,0,0],range=[-90,90]),dict(id='cap_mount',parent='axle',child='cap',kind='fixed')])


def polar_solid(name, z_levels, radii_grid, angles):
    """Build a watertight single-shell solid from Z rings with angle-varying radii."""
    n = len(angles)
    vertices, rings, triangles = [], [], []
    bottom = len(vertices)
    vertices.append([0.0, 0.0, z_levels[0]])
    for z, radii in zip(z_levels, radii_grid):
        ring = []
        for theta, r in zip(angles, radii):
            ring.append(len(vertices))
            vertices.append([r * math.cos(theta), r * math.sin(theta), z])
        rings.append(ring)
    top = len(vertices)
    vertices.append([0.0, 0.0, z_levels[-1]])
    for j in range(n):
        jn = (j + 1) % n
        triangles.append([bottom, rings[0][jn], rings[0][j]])
        triangles.append([top, rings[-1][j], rings[-1][jn]])
    for k in range(len(rings) - 1):
        r0, r1 = rings[k], rings[k + 1]
        for j in range(n):
            jn = (j + 1) % n
            triangles.extend([[r0[j], r0[jn], r1[jn]], [r0[j], r1[jn], r1[j]]])
    return dict(id=name, vertices=vertices, triangles=triangles)


def polar_tube(name, z_levels, inner_grid, outer_grid, angles):
    """Build a watertight hollow annular shell from inner and outer Z rings."""
    n = len(angles)
    vertices, inner_rings, outer_rings, triangles = [], [], [], []
    for z, ri_row, ro_row in zip(z_levels, inner_grid, outer_grid):
        ir, or_ = [], []
        for theta, ri, ro in zip(angles, ri_row, ro_row):
            ir.append(len(vertices))
            vertices.append([ri * math.cos(theta), ri * math.sin(theta), z])
            or_.append(len(vertices))
            vertices.append([ro * math.cos(theta), ro * math.sin(theta), z])
        inner_rings.append(ir)
        outer_rings.append(or_)
    for k in range(len(z_levels) - 1):
        o0, o1 = outer_rings[k], outer_rings[k + 1]
        i0, i1 = inner_rings[k], inner_rings[k + 1]
        for j in range(n):
            jn = (j + 1) % n
            triangles.extend([[o0[j], o0[jn], o1[jn]], [o0[j], o1[jn], o1[j]]])
            triangles.extend([[i0[jn], i0[j], i1[j]], [i0[jn], i1[j], i1[jn]]])
    for j in range(n):
        jn = (j + 1) % n
        triangles.extend([[outer_rings[0][jn], outer_rings[0][j], inner_rings[0][j]],
                          [outer_rings[0][jn], inner_rings[0][j], inner_rings[0][jn]]])
        triangles.extend([[outer_rings[-1][j], outer_rings[-1][jn], inner_rings[-1][jn]],
                          [outer_rings[-1][j], inner_rings[-1][jn], inner_rings[-1][j]]])
    return dict(id=name, vertices=vertices, triangles=triangles)


def bayonet_lock(with_lugs=True, retainer='bayonet'):
    """Twist-lock bayonet shaft and cap: retained axially/radially/in-tilt, unlocked by 90 deg twist."""
    n = 72
    angles = [step * 2 * math.pi / n for step in range(n)]
    def in_lug(theta):
        deg = (math.degrees(theta) + 180) % 360 - 180
        return abs(deg) <= 15 or abs(abs(deg) - 180) <= 15
    def in_slot(theta):
        deg = math.degrees(theta) % 360
        return abs(deg - 90) <= 25 or abs(deg - 270) <= 25
    socket_z = [-2.0, 0.0, 0.05, 9.95, 10.0, 13.0, 13.05, 14.0]
    lug_r = [7.0 if (with_lugs and in_lug(t)) else 4.0 for t in angles]
    socket_r = [[12.0] * n, [12.0] * n, [4.0] * n, [4.0] * n, lug_r, lug_r, [4.0] * n, [4.0] * n]
    socket = polar_solid('socket', socket_z, socket_r, angles)
    cap_z = [0.6, 9.4, 9.5, 13.6]
    lower_in = [7.6 if in_slot(t) else 4.4 for t in angles]
    cap_in = [lower_in, lower_in, [7.6] * n, [7.6] * n]
    cap_out = [[10.0] * n for _ in cap_z]
    cap = polar_tube('cap', cap_z, cap_in, cap_out, angles)
    conn = dict(id='cap_lock', parent='socket', child='cap', kind='fixed', retainer=retainer)
    if retainer in ('bayonet', 'threaded'):
        conn['axis'] = [0, 0, 1]
    value = assembly([socket, cap], 'socket', [conn])
    value['assembly']['manufacturing'] = dict(
        mode='separate',
        steps=[dict(part='cap', actions=[
            dict(kind='rotate', pivot=[0, 0, 0], axis=[0, 0, 1], degrees=90, pitchMm=0),
            dict(kind='translate', delta=[0, 0, 20]),
        ])],
    )
    return value


def threaded_bolt_nut(pitch=4.0, retainer='threaded'):
    """Right-hand helical bolt and nut: self-locking under friction, unscrewed helically."""
    n = 24
    angles = [step * 2 * math.pi / n for step in range(n)]
    def thread_r(theta, z, clearance=0.0):
        phase = (z / pitch - theta / (2 * math.pi)) % 1.0
        wave = 1.0 - abs(2.0 * phase - 1.0)
        return 4.0 + 1.6 * wave + clearance
    bolt_z = [-2.0, 0.0, 0.1] + [0.5 + 0.25 * k for k in range(47)]
    bolt_r = [[12.0] * n, [12.0] * n, [4.0] * n] + [[thread_r(t, z) for t in angles] for z in bolt_z[3:]]
    bolt = polar_solid('bolt', bolt_z, bolt_r, angles)
    nut_z = [2.0 + 0.25 * k for k in range(25)]
    nut_in = [[thread_r(t, z, 0.5) for t in angles] for z in nut_z]
    nut_out = [[9.5] * n for _ in nut_z]
    nut = polar_tube('nut', nut_z, nut_in, nut_out, angles)
    conn = dict(id='nut_lock', parent='bolt', child='nut', kind='fixed', retainer=retainer)
    if retainer in ('bayonet', 'threaded'):
        conn['axis'] = [0, 0, 1]
    value = assembly([bolt, nut], 'bolt', [conn])
    value['settings'].update(friction=0.25, maxPenetrationMm=0.35, initialPenetrationMm=0.15)
    value['assembly']['manufacturing'] = dict(
        mode='separate',
        steps=[dict(part='nut', actions=[
            dict(kind='rotate', pivot=[0, 0, 0], axis=[0, 0, 1], degrees=990, pitchMm=pitch),
        ])],
    )
    return value


def snap_collar(max_interference=0.9, with_guard=False):
    """Keyed shaft with annular snap bead and collar: retained in 6 DOF, bounded snap removal."""
    n = 36
    angles = [step * 2 * math.pi / n for step in range(n)]
    # Oval/double-keyed profile prevents Z rotation so full 6-DOF snap retention holds.
    def shaft_r(theta, bead=0.0, clearance=0.0):
        return 4.0 + 1.2 * abs(math.cos(theta)) + bead + clearance
    post_z = [-2.0, 0.0, 0.05, 8.0, 9.0, 10.0, 11.0]
    post_r = [
        [10.0] * n, [10.0] * n,
        [shaft_r(t) for t in angles],
        [shaft_r(t) for t in angles],
        [shaft_r(t, bead=0.9) for t in angles],
        [shaft_r(t) for t in angles],
        [shaft_r(t) for t in angles],
    ]
    post = polar_solid('post', post_z, post_r, angles)
    collar_z = [0.4, 7.6]
    collar_in = [[shaft_r(t, clearance=0.3) for t in angles] for _ in collar_z]
    collar_out = [[8.5] * n for _ in collar_z]
    collar = polar_tube('collar', collar_z, collar_in, collar_out, angles)
    bodies = [post, collar]
    connections = [dict(id='collar_snap', parent='post', child='collar', kind='fixed', retainer='snap')]
    steps = [dict(part='collar', actions=[dict(kind='snap', delta=[0, 0, 12], maxInterferenceMm=max_interference)])]
    if with_guard:
        # Unrelated third part placed along collar's snap path to verify mate-only interference isolation.
        bodies.append(box('guard', [0, 7.0, 10.5], [10.0, 1.5, 1.0]))
        connections.append(dict(id='guard_mount', parent='post', child='guard', kind='fixed', retainer='friction'))
        steps.append(dict(part='guard', actions=[dict(kind='translate', delta=[0, 15, 0])]))
    value = assembly(bodies, 'post', connections)
    value['settings'].update(maxPenetrationMm=0.35, initialPenetrationMm=0.15)
    value['assembly']['manufacturing'] = dict(mode='separate', steps=steps)
    return value


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('fixture', choices=['normal','broken','blocked','slider','blocked-slider','wheel'])
    args = parser.parse_args()
    value = wheel() if args.fixture == 'wheel' else slider(args.fixture == 'blocked-slider') if 'slider' in args.fixture else request(args.fixture == 'broken')
    if args.fixture == 'blocked':
        value['bodies'].append(box('obstacle', [0,-13,10], [20,2,3]))
        value['assembly']['parts'].append(dict(id='obstacle',mesh='obstacle'))
        value['assembly']['connections'].append(dict(id='obstacle_mount',parent=value['assembly']['root'],child='obstacle',kind='fixed'))
    print(json.dumps(value))
