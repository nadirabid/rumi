"""Exercise assembly movement and retention through the compiled native protocol."""
import argparse
import copy
import json
import math
from pathlib import Path
import subprocess
import sys
import unittest
sys.dont_write_bytecode = True
from fixtures import (
    request, box, slider, wheel, assembly, two_wheels, loose_pin, loose_cap, revolution,
    bayonet_lock, threaded_bolt_nut, snap_collar,
)

parser = argparse.ArgumentParser()
parser.add_argument('executable', type=Path)
args, remaining = parser.parse_known_args()
EXE = args.executable.resolve()


def run(value):
    completed = subprocess.run([str(EXE)], input=json.dumps(value), capture_output=True, text=True, timeout=240)
    return completed.returncode, json.loads(completed.stdout)


class NativeTests(unittest.TestCase):
    def assert_verified(self, value):
        code, result = run(value)
        self.assertEqual(code,0,result)
        self.assertEqual(result['status'],'passed',result)
        self.assertTrue(result['assemblyVerified'],result)
        self.assertTrue(result['coverage']['complete'])
        self.assertEqual(set(result['coverage']['connections']), {c['id'] for c in value['assembly']['connections']})
        self.assertEqual(result['policy'],value['settings'])
        return result

    def assert_collision(self, finding, parts, penetration_limit):
        details = finding['details']
        self.assertGreater(details['maxPenetrationMm'], penetration_limit)
        self.assertEqual(details['collision']['parts'], parts)
        position = details['collision']['positionMm']
        self.assertEqual(len(position), 3)
        self.assertTrue(all(math.isfinite(coordinate) for coordinate in position), position)
        return position

    def test_single_solid_static_part(self):
        self.assert_verified(assembly([box('part',[0,0,0],[2,2,2])],'part',[]))

    def test_single_declared_part_cannot_hide_disconnected_solids(self):
        first=box('part',[0,0,0],[2,2,2]);second=box('other',[10,0,0],[2,2,2]);offset=len(first['vertices'])
        first['vertices'].extend(second['vertices']);first['triangles'].extend([[i+offset for i in f] for f in second['triangles']])
        code,result=run(assembly([first],'part',[]))
        self.assertEqual(code,0,result);self.assertEqual(result['status'],'needs_repair');self.assertFalse(result['assemblyVerified'])

    def test_actual_collision_smoke(self):
        completed=subprocess.run([str(EXE),'--self-test'],capture_output=True,text=True,timeout=30,check=True)
        self.assertTrue(json.loads(completed.stdout)['ok'])
        self.assertEqual(json.loads(completed.stdout)['protocolVersion'],2)

    def test_retains_and_moves_connected_hinge(self):
        value=request()
        # Frictionless cone contact needs finer steps to remain within the 0.05 mm penetration limit.
        value['settings']['timeStepSeconds']=.000125
        result=self.assert_verified(value)
        probes=result['connections'][0]['probes']
        self.assertTrue(any(p['kind']=='movement' and abs(p['actual']['hinge']+90)<3 for p in probes))
        self.assertTrue(any(p['kind']=='movement' and abs(p['actual']['hinge']+45)<3 for p in probes))

    def test_detects_missing_connector(self):
        code,result=run(request(True))
        self.assertEqual(code,0,result)
        self.assertEqual(result['status'],'needs_repair',result)
        self.assertIn('unretained_part',[c['code'] for c in result['checks']])
        self.assertFalse(result['assemblyVerified'])

    def test_translated_geometry_preserves_missing_connector(self):
        value=request(True);shift=[10000,-20000,30000]
        for b in value['bodies']:b['vertices']=[[p[i]+shift[i] for i in range(3)] for p in b['vertices']]
        value['assembly']['connections'][0]['pivot']=[shift[0],shift[1],shift[2]+.25]
        code,result=run(value)
        self.assertEqual(code,0,result)
        self.assertEqual(result['checks'][0]['code'],'unretained_part')

    def test_disconnected_mesh_cannot_be_one_physical_part(self):
        value=request();moving=value['bodies'][1];detached=box('detached',[50,0,0],[1,1,1]);offset=len(moving['vertices'])
        moving['vertices'].extend(detached['vertices']);moving['triangles'].extend([[i+offset for i in f] for f in detached['triangles']])
        code,result=run(value)
        self.assertEqual(code,0,result)
        self.assertEqual(result['checks'][0]['code'],'disconnected_body')
        self.assertFalse(result['coverage']['complete'])

    def test_retains_and_moves_prismatic_slider(self):
        self.assert_verified(slider())

    def test_rest_collision_reports_parts_and_world_position(self):
        value = slider(True)
        shift = [100, 200, 300]
        value['bodies'].reverse()
        for body in value['bodies']:
            body['vertices'] = [[coordinate + offset for coordinate, offset in zip(vertex, shift)]
                                for vertex in body['vertices']]
        value['assembly']['connections'][0]['pivot'] = shift
        code, result = run(value)
        self.assertEqual(code,0,result)
        self.assertEqual(result['status'],'needs_repair',result)
        finding = result['checks'][0]
        self.assertEqual(finding['code'], 'initial_interference')
        position = self.assert_collision(finding, ['frame', 'moving'], value['settings']['maxPenetrationMm'])
        for coordinate, offset in zip(position, shift):
            self.assertLessEqual(abs(coordinate - offset), 3, position)

    def test_retention_collision_reports_parts(self):
        value = wheel()
        value['settings']['maxPenetrationMm'] = .005
        code, result = run(value)
        self.assertEqual(code, 0, result)
        self.assertEqual(result['status'], 'needs_repair', result)
        finding = result['checks'][0]
        self.assertEqual(finding['code'], 'excessive_penetration')
        self.assertEqual(finding['details']['kind'], 'retention')
        self.assert_collision(finding, ['axle', 'wheel'], value['settings']['maxPenetrationMm'])

    def test_captive_wheel_moves_through_both_half_turns(self):
        result=self.assert_verified(wheel())
        positions=[p['actual']['wheel'] for p in result['connections'][0]['probes'] if p['kind']=='movement']
        self.assertTrue(any(abs(v-180)<3 for v in positions));self.assertTrue(any(abs(v+180)<3 for v in positions))

    def test_captive_part_with_play_is_retained(self):
        # Retention allows travel through the play but requires the part to stop at its stops.
        value=wheel(.8);value['settings'].update(retentionTravelMm=2,retentionTiltDegrees=15)
        result=self.assert_verified(value)
        retention=[p for p in result['connections'][0]['probes'] if p['kind']=='retention']
        self.assertTrue(retention);self.assertTrue(all(p['retentionTravelMm']==2 for p in retention))

    def test_part_without_retaining_feature_escapes(self):
        value=wheel()
        value['bodies'][0]=revolution('axle',[(0,-5),(3.8,-5),(3.8,5),(0,5)])
        code,result=run(value)
        self.assertEqual(code,0,result);self.assertEqual(result['status'],'needs_repair',result)
        self.assertEqual(result['checks'][0]['code'],'unretained_part')

    def test_complete_assembly_with_two_dynamic_wheels(self):
        value=two_wheels()
        value['assembly']['sequences']=[dict(id='both',waypoints=[dict(lower=45,upper=-45),dict(lower=0,upper=0)])]
        result=self.assert_verified(value)
        self.assertEqual(result['coverage']['sequences'],['both'])

    def test_captive_wheel_under_production_gravity_and_friction(self):
        value=wheel();value['settings'].update(gravityMps2=[0,0,-9.81],friction=.2,movementSampleDegrees=15)
        self.assert_verified(value)

    def test_loose_pin_cannot_be_frozen_as_support(self):
        code,result=run(loose_pin())
        self.assertEqual(code,0,result);self.assertEqual(result['status'],'needs_repair',result)
        self.assertEqual(result['checks'][0]['connection'],'pin_mount')

    def test_loose_cap_cannot_retain_the_wheel(self):
        code,result=run(loose_cap())
        self.assertEqual(code,0,result);self.assertEqual(result['status'],'needs_repair',result)
        self.assertIn(result['checks'][0]['connection'],['wheel','cap_mount'])

    def test_separated_fixed_parts_fail_retention(self):
        value=assembly([box('root',[0,0,0],[2,2,2]),box('loose',[10,0,0],[1,1,1])],'root',[dict(id='attachment',parent='root',child='loose',kind='fixed')])
        code,result=run(value)
        self.assertEqual(code,0,result);self.assertEqual(result['checks'][0]['code'],'unretained_part')

    def test_separate_parts_without_declared_removal_steps_are_verified_by_probes(self):
        value=wheel();value['assembly']['manufacturing']['mode']='separate'
        result=self.assert_verified(value)
        self.assertEqual(result['coverage']['assemblySteps'],[])

    def test_separate_slider_has_sampled_removal_route(self):
        value=slider();value['assembly']['manufacturing']=dict(mode='separate',steps=[dict(part='moving',path=[[0,0,0],[20,0,0]])])
        result=self.assert_verified(value)
        self.assertEqual(result['coverage']['assemblySteps'],['moving'])

    def test_removal_path_cannot_cross_the_frame(self):
        value=slider();value['assembly']['manufacturing']=dict(mode='separate',steps=[dict(part='moving',path=[[0,0,0],[0,20,0]])])
        code,result=run(value)
        self.assertEqual(code,0,result);self.assertEqual(result['status'],'needs_repair',result)
        finding = result['checks'][0]
        self.assertEqual(finding['code'], 'assembly_path_interference')
        self.assert_collision(finding, ['frame', 'moving'], value['settings']['maxPenetrationMm'])
        offset = finding['details']['offsetMm']
        self.assertEqual(len(offset), 3)
        for coordinate, expected in zip(offset, [0, .2, 0]):
            self.assertAlmostEqual(coordinate, expected)
        self.assertFalse(result['coverage']['complete'])

    def test_excessive_sequence_work_is_unverified_without_partial_pass(self):
        value=wheel();value['settings']['maxTotalSteps']=250000;value['assembly']['sequences']=[dict(id=str(i),waypoints=[dict(wheel=0) for _ in range(64)]) for i in range(4)]
        code,result=run(value)
        self.assertEqual(code,0,result);self.assertEqual(result['status'],'review');self.assertFalse(result['coverage']['complete'])
        self.assertEqual(result['checks'][0]['code'],'probe_budget_exhausted')

    def test_large_work_plan_still_detects_a_loose_baseline_part(self):
        value=loose_pin();value['settings']['maxTotalSteps']=250000;value['assembly']['sequences']=[dict(id=str(i),waypoints=[dict(wheel=0) for _ in range(64)]) for i in range(4)]
        code,result=run(value)
        self.assertEqual(code,0,result);self.assertEqual(result['status'],'needs_repair',result)
        self.assertFalse(result['coverage']['complete']);self.assertFalse(result['assemblyVerified'])
        codes=[c['code'] for c in result['checks']]
        self.assertIn('probe_budget_exhausted',codes);self.assertIn('unretained_part',codes)
        self.assertTrue(any(p['kind']=='retention' for c in result['connections'] for p in c['probes']))

    def test_closed_loop_is_not_reported_as_verified(self):
        value=wheel();value['assembly']['connections'].append(dict(id='loop',parent='wheel',child='axle',kind='fixed'))
        code,result=run(value)
        self.assertEqual(code,0,result);self.assertEqual(result['status'],'review',result)
        self.assertFalse(result['assemblyVerified']);self.assertEqual(len(result['connections']),2)

    def test_inadequate_probe_load_remains_unverified(self):
        value=request(True);value['settings']['forceN']=.000001
        code,result=run(value)
        self.assertEqual(code,0,result);self.assertEqual(result['status'],'review',result)
        self.assertEqual(result['checks'][0]['code'],'probe_inconclusive')

    def test_simulation_policy_rejects_out_of_bounds_settings(self):
        for name,setting in [('gravityMps2',[0,0,-21]),('friction',1.01),('movementSampleMm',.01),('assemblySampleMm',3),('maxTotalSteps',999),('maxTotalSteps',10000001),('maxTotalSteps',1000.5),('retentionWorkers',0),('retentionWorkers',5),('retentionWorkers',1.5),('retentionTravelMm',.05),('retentionTravelMm',11),('retentionTiltDegrees',.5),('retentionTiltDegrees',46)]:
            value=assembly([box('part',[0,0,0],[2,2,2])],'part',[]);value['settings'][name]=setting
            code,result=run(value)
            self.assertEqual(code,2,result);self.assertEqual(result['error']['code'],'invalid_request')

    def test_larger_allowance_completes_the_same_motion_plan(self):
        value=slider()
        value['assembly']['sequences']=[dict(id='repeat',waypoints=[{value['assembly']['connections'][0]['id']: 0} for _ in range(64)])]
        value['settings']['maxTotalSteps']=100000
        code,limited=run(value)
        self.assertEqual(code,0,limited)
        self.assertFalse(limited['coverage']['complete'])
        self.assertIn('probe_budget_exhausted',[c['code'] for c in limited['checks']])
        value['settings']['maxTotalSteps']=2000000
        self.assert_verified(value)

    def test_parallel_probes_preserve_serial_findings_and_coverage(self):
        for value in [slider(),slider(True),wheel(),loose_pin(),two_wheels()]:
            outcomes=[]
            for workers in [1,2,4]:
                value['settings']['retentionWorkers']=workers
                code,result=run(value)
                self.assertEqual(code,0,result)
                result.pop('elapsedMs');result['policy'].pop('retentionWorkers')
                outcomes.append(result)
            self.assertEqual(outcomes[0],outcomes[1])
            self.assertEqual(outcomes[0],outcomes[2])

    def test_legacy_protocol_cannot_pass(self):
        value=request();value['version']=1
        code,result=run(value)
        self.assertEqual(code,2,result);self.assertEqual(result['error']['code'],'invalid_request')

    def test_invalid_triangle_index_is_structured_failure(self):
        value=request();value['bodies'][0]['triangles'][0][0]=-1
        code,result=run(value)
        self.assertEqual(code,2,result);self.assertEqual(result['error']['code'],'invalid_request')

    def test_separate_slider_accepts_translate_actions(self):
        value = slider()
        value['assembly']['manufacturing'] = dict(
            mode='separate',
            steps=[dict(part='moving', actions=[dict(kind='translate', delta=[10, 0, 0]), dict(kind='translate', delta=[10, 0, 0])])],
        )
        result = self.assert_verified(value)
        self.assertEqual(result['coverage']['assemblySteps'], ['moving'])

    def test_bayonet_retainer_passes_10_dof_and_twist_translate_disassembly(self):
        value = bayonet_lock()
        result = self.assert_verified(value)
        self.assertEqual(result['coverage']['assemblySteps'], ['cap'])
        probes = [p for p in result['connections'][0]['probes'] if p['kind'] == 'retention']
        self.assertEqual(len(probes), 10)
        self.assertEqual(result['connections'][0]['retainer'], 'bayonet')

    def test_bayonet_without_lugs_fails_axial_retention(self):
        value = bayonet_lock(with_lugs=False)
        code, result = run(value)
        self.assertEqual(code, 0, result)
        self.assertEqual(result['status'], 'needs_repair', result)
        self.assertEqual(result['checks'][0]['code'], 'unretained_part')

    def test_bayonet_as_rigid_retainer_fails_unscrewing_torque(self):
        value = bayonet_lock(with_lugs=True, retainer='rigid')
        code, result = run(value)
        self.assertEqual(code, 0, result)
        self.assertEqual(result['status'], 'needs_repair', result)
        self.assertEqual(result['checks'][0]['code'], 'unretained_part')

    def test_bayonet_disassembly_rejects_pullout_without_twist(self):
        value = bayonet_lock()
        value['assembly']['manufacturing']['steps'] = [dict(part='cap', actions=[dict(kind='translate', delta=[0, 0, 20])])]
        code, result = run(value)
        self.assertEqual(code, 0, result)
        self.assertEqual(result['status'], 'needs_repair', result)
        self.assertEqual(result['checks'][0]['code'], 'assembly_path_interference')

    def test_threaded_retainer_passes_and_helical_unscrewing_succeeds(self):
        value = threaded_bolt_nut()
        result = self.assert_verified(value)
        self.assertEqual(result['coverage']['assemblySteps'], ['nut'])
        probes = [p for p in result['connections'][0]['probes'] if p['kind'] == 'retention']
        self.assertEqual(len(probes), 10)

    def test_threaded_disassembly_rejects_wrong_pitch(self):
        value = threaded_bolt_nut()
        value['assembly']['manufacturing']['steps'] = [
            dict(part='nut', actions=[dict(kind='rotate', pivot=[0, 0, 0], axis=[0, 0, 1], degrees=990, pitchMm=0)]),
        ]
        code, result = run(value)
        self.assertEqual(code, 0, result)
        self.assertEqual(result['status'], 'needs_repair', result)
        self.assertEqual(result['checks'][0]['code'], 'assembly_path_interference')
        self.assertEqual(result['checks'][0]['details']['kind'], 'rotate')

    def test_snap_collar_passes_retention_and_bounded_snap_disassembly(self):
        value = snap_collar(max_interference=0.9)
        result = self.assert_verified(value)
        self.assertEqual(result['coverage']['assemblySteps'], ['collar'])
        probes = [p for p in result['connections'][0]['probes'] if p['kind'] == 'retention']
        self.assertEqual(len(probes), 12)

    def test_snap_rejects_interference_above_limit(self):
        value = snap_collar(max_interference=0.2)
        code, result = run(value)
        self.assertEqual(code, 0, result)
        self.assertEqual(result['status'], 'needs_repair', result)
        self.assertEqual(result['checks'][0]['code'], 'assembly_path_interference')
        self.assertEqual(result['checks'][0]['details']['reason'], 'snap_interference_exceeded')

    def test_snap_rejects_endpoint_interference(self):
        value = snap_collar(max_interference=0.9)
        value['assembly']['manufacturing']['steps'] = [
            dict(part='collar', actions=[dict(kind='snap', delta=[0, 0, 5], maxInterferenceMm=0.9)]),
        ]
        code, result = run(value)
        self.assertEqual(code, 0, result)
        self.assertEqual(result['status'], 'needs_repair', result)
        self.assertEqual(result['checks'][0]['code'], 'assembly_path_interference')
        self.assertEqual(result['checks'][0]['details']['reason'], 'snap_end_interference')

    def test_snap_rejects_unrelated_third_part_collision(self):
        value = snap_collar(max_interference=1.5, with_guard=True)
        code, result = run(value)
        self.assertEqual(code, 0, result)
        self.assertEqual(result['status'], 'needs_repair', result)
        codes = [c['code'] for c in result['checks']]
        self.assertIn('assembly_path_interference', codes)
        interference = next(c for c in result['checks'] if c['code'] == 'assembly_path_interference')
        self.assertEqual(interference['details']['reason'], 'snap_unrelated_part_interference')
        self.assertEqual(interference['details']['collision']['parts'], ['collar', 'guard'])

    def test_friction_retainer_emits_unverified_warning(self):
        value = assembly(
            [box('base', [0, 0, 0], [5, 5, 2]), box('peg', [0, 0, 4.2], [2, 2, 2])],
            'base',
            [dict(id='press_fit', parent='base', child='peg', kind='fixed', retainer='friction')],
        )
        code, result = run(value)
        self.assertEqual(code, 0, result)
        self.assertEqual(result['status'], 'review', result)
        self.assertFalse(result['assemblyVerified'])
        self.assertFalse(result['coverage']['complete'])
        self.assertEqual(result['checks'][0]['code'], 'retainer_unverified_friction')
        self.assertEqual(result['checks'][0]['severity'], 'warning')
        self.assertEqual(result['checks'][0]['connection'], 'press_fit')

    def test_split_penetration_enforces_strict_initial_and_relaxed_dynamic(self):
        # Rest interference of 0.25 mm fails initialPenetrationMm=0.15 even when maxPenetrationMm=0.35.
        value = slider(True)
        value['settings']['maxPenetrationMm'] = 0.35
        code, result = run(value)
        self.assertEqual(code, 0, result)
        self.assertEqual(result['status'], 'needs_repair', result)
        self.assertEqual(result['checks'][0]['code'], 'initial_interference')
        self.assertIn('collision', result['checks'][0]['details'])
        # Explicit initialPenetrationMm also applies strictly to rigid assembly routes.
        route = slider()
        route['settings'].update(maxPenetrationMm=0.35, initialPenetrationMm=0.05)
        route['assembly']['manufacturing'] = dict(mode='separate', steps=[dict(part='moving', path=[[0, 0, 0], [0, 20, 0]])])
        code, result = run(route)
        self.assertEqual(code, 0, result)
        self.assertEqual(result['status'], 'needs_repair', result)
        self.assertEqual(result['checks'][0]['code'], 'assembly_path_interference')

    def test_invalid_v2_retainer_and_action_declarations_fail_loud(self):
        bad_bayonet = bayonet_lock()
        del bad_bayonet['assembly']['connections'][0]['axis']
        code, result = run(bad_bayonet)
        self.assertEqual(code, 2, result)
        self.assertEqual(result['error']['code'], 'invalid_request')

        bad_snap = snap_collar(max_interference=3.0)
        code, result = run(bad_snap)
        self.assertEqual(code, 2, result)
        self.assertEqual(result['error']['code'], 'invalid_request')

        bad_revolute = wheel()
        bad_revolute['assembly']['connections'][0]['retainer'] = 'bayonet'
        code, result = run(bad_revolute)
        self.assertEqual(code, 2, result)
        self.assertEqual(result['error']['code'], 'invalid_request')

        bad_step = slider()
        bad_step['assembly']['manufacturing'] = dict(
            mode='separate',
            steps=[dict(part='moving', path=[[0, 0, 0], [20, 0, 0]], actions=[dict(kind='translate', delta=[20, 0, 0])])],
        )
        code, result = run(bad_step)
        self.assertEqual(code, 2, result)
        self.assertEqual(result['error']['code'], 'invalid_request')


if __name__=='__main__':unittest.main(argv=['native.py',*remaining],verbosity=2)
