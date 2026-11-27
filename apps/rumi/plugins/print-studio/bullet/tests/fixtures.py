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
