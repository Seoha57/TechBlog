---
layout: post
title: "Kubernetes etcd 백업과 복구를 설계하는 법: Snapshot·복구 절차·재해 대응의 경계"
categories: [Infrastructure]
tags: [kubernetes, etcd, backup, restore, disaster-recovery, infrastructure]
description: "Kubernetes control plane의 etcd가 보관하는 상태와 snapshot 백업·복구 절차를 기반 개념부터 설명하고, 실제 재해 대응을 위한 검증 기준을 정리합니다."
---

## 먼저 답하기

### Q. Kubernetes 리소스 YAML을 Git에 두면 etcd 백업은 필요 없나요?

A. Git에 선언형 manifest를 보관하는 것은 중요하지만 cluster의 전체 상태를 복원하지는 못합니다. etcd에는 Kubernetes API object, namespace, Secret, ConfigMap, workload 상태, 일부 control plane 메타데이터가 저장됩니다. Git에 없는 runtime object, controller가 만든 상태, CRD(Custom Resource Definition) 객체, 접근 권한 변경, Secret 복구까지 고려하려면 별도의 backup·restore 계획이 필요합니다. 반대로 etcd snapshot 하나가 PersistentVolume의 application data나 외부 cloud resource를 모두 복구하는 것도 아닙니다.

### Q. snapshot 파일만 만들면 재해 복구가 끝난 건가요?

A. 아닙니다. snapshot은 특정 시점의 etcd 데이터를 보관하는 출발점입니다. 실제 복구에는 어떤 cluster를 대상으로 하는지, control plane 구성 방식은 무엇인지, 인증서와 encryption key는 어디에 있는지, node·network·storage·외부 identity가 어떤 상태인지, 누가 어떤 순서로 판단하고 실행하는지가 포함됩니다. 정기적으로 restore를 격리된 환경에서 검증하지 않으면 backup이 실제로 사용 가능한지 알 수 없습니다.

## 먼저 알아둘 기반 기술

### etcd와 Kubernetes control plane

etcd는 분산 key-value store이며 Kubernetes control plane이 cluster의 원하는 상태와 여러 API object를 저장하는 핵심 구성 요소입니다. API server는 Pod, Deployment, Service, Secret, Role 같은 객체를 etcd에 읽고 쓰며, scheduler와 controller manager는 이 상태를 보고 실제 node의 상태를 원하는 상태에 맞추려 합니다. worker node의 container image와 PersistentVolume 데이터가 etcd 안에 직접 들어 있는 것은 아니지만, 어떤 workload가 어떤 volume·secret·service account를 사용해야 하는지는 etcd의 object와 연결됩니다.

따라서 etcd가 손상되거나 control plane이 완전히 사라지면, node에서 이미 실행 중인 container가 잠시 남아 있어도 cluster를 정상적으로 관리하기 어렵습니다. 새 Pod scheduling, deployment 변경, secret 조회, service endpoint 갱신, autoscaling 같은 control plane 기능이 실패할 수 있습니다. etcd backup은 application backup과 다른 계층의 보호 수단이며, 둘 중 하나만으로 전체 서비스를 복원했다고 말할 수 없습니다.

### RPO와 RTO

RPO(Recovery Point Objective)는 얼마나 최근 시점까지 데이터를 복원해야 하는지, RTO(Recovery Time Objective)는 장애 뒤 서비스를 어느 시간 안에 복원해야 하는지를 뜻합니다. etcd snapshot 주기가 6시간이면 최악의 경우 최근 6시간의 Kubernetes object 변경을 잃을 수 있습니다. RPO가 더 짧아야 한다면 snapshot 주기, 저장 위치, 선언형 배포 기록, 운영 변경 절차를 함께 조정해야 합니다. RTO가 짧아야 한다면 담당자·접근 권한·runbook·격리 restore 검증·외부 dependency 복구까지 준비돼 있어야 합니다.

RPO와 RTO는 숫자를 예쁘게 정하는 일이 아닙니다. 새 namespace, Secret rotation, RBAC 변경, 배포 rollout, CRD 기반 operator 상태 중 무엇이 얼마나 자주 바뀌고, 유실되면 어떤 고객 영향이 생기는지에서 출발합니다. GitOps를 쓰는 cluster는 일부 manifest를 다시 적용할 수 있지만, Git에 없는 긴급 변경이나 runtime controller 상태가 남을 수 있음을 전제로 해야 합니다.

## 무엇을 백업하고 무엇을 별도로 보호하는가

etcd snapshot은 Kubernetes API object의 시점 상태를 보호합니다. 하지만 application database, object storage, message queue, container registry image, cloud load balancer 설정, DNS record, IAM identity가 같은 snapshot 안에 들어간다고 가정하면 안 됩니다. PV(PersistentVolume)의 data는 storage class와 provider의 snapshot·backup 정책으로, 외부 SaaS와 cloud resource는 해당 provider의 backup·infrastructure-as-code·감사 기록으로 별도 보호해야 할 수 있습니다.

cluster restore 계획에는 이 경계를 표로 적는 것이 좋습니다. 예를 들어 Deployment·Service·Secret은 etcd snapshot 또는 Git manifest로, database data는 DB-native backup으로, image는 registry retention과 immutable tag로, DNS는 IaC 또는 provider export로 복구한다고 정할 수 있습니다. 어떤 data가 어디에 있고 누가 복구 책임을 갖는지 모르면, incident 중 etcd를 복원한 뒤에도 서비스가 안 되는 이유를 찾느라 시간을 잃습니다.

Secret은 특히 주의합니다. Kubernetes Secret은 base64 encoding일 뿐 암호화 그 자체가 아니며, cluster encryption-at-rest 설정과 key 관리에 따라 보호 수준이 달라집니다. snapshot 파일과 backup bucket에 Secret 원문에 가까운 정보가 포함될 수 있다고 보고, encryption, 접근 권한, audit, 보관 기간, 삭제 정책을 적용합니다. backup을 위해 credential을 넓게 공유하는 것이 새로운 사고 경로가 되어서는 안 됩니다.

## snapshot 생성과 보관 원칙

etcdctl 같은 도구로 snapshot을 만들 수 있지만, 정확한 endpoint·TLS certificate·권한·명령은 self-managed, kubeadm, managed Kubernetes 등 control plane 구성에 따라 다릅니다. managed service는 provider가 control plane backup을 관리하거나 사용자가 etcd에 직접 접근하지 못하게 할 수 있습니다. 먼저 사용 중인 플랫폼의 공식 복구 문서를 확인하고, production control plane에서 임의 명령을 시험하지 않습니다.

다음은 흐름을 보여 주는 예시일 뿐이며, 실제 파일 경로와 certificate는 환경 문서에 맞춰야 합니다.

```bash
ETCDCTL_API=3 etcdctl snapshot save /secure/backup/etcd-2026-11-11.db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/path/to/ca.crt \
  --cert=/path/to/client.crt \
  --key=/path/to/client.key

ETCDCTL_API=3 etcdctl snapshot status /secure/backup/etcd-2026-11-11.db -w table
```

snapshot이 생성됐다는 로그만으로 성공을 판단하지 않습니다. checksum, size, snapshot status, 생성 시각, source cluster 식별자, encryption 여부, 원격 복제 완료 여부를 확인합니다. 백업을 같은 control plane disk에만 두면 node나 disk 손실 때 함께 사라질 수 있으므로, 승인된 별도 storage와 region·account 분리를 검토합니다. 그러나 너무 많은 위치에 평문 snapshot을 복사하면 노출 면적이 넓어질 수 있으므로, 복제와 접근 권한을 함께 설계합니다.

보관 정책도 필요합니다. 최근 snapshot은 빠른 복구를 위해 자주 남기고, 더 오래된 snapshot은 규정·감사·비용에 맞춰 줄일 수 있습니다. delete job이 잘못된 최신 backup을 지우지 않도록 generation·retention·immutable storage·복구 가능 여부를 확인합니다. backup failure와 원격 복제 failure에는 사람이 행동할 alert가 있어야 합니다. 성공 로그만 모으는 backup은 장애 때 가장 최근 정상본이 언제인지 알려 주지 못합니다.

## restore는 새 cluster를 만들기보다 위험할 수 있다

etcd restore는 기존 데이터를 덮거나 새 data directory를 만드는 민감한 작업입니다. control plane이 여러 node인 HA 구성에서는 member 정보와 peer 설정, API server가 참조하는 etcd endpoint, static Pod manifest, 인증서가 서로 맞아야 합니다. 일부 node만 restore하거나 old data directory와 새 snapshot data를 섞으면 quorum 문제나 일관성 오류가 생길 수 있습니다. 실제 절차는 Kubernetes version과 설치 방식에 맞는 공식 runbook을 따르고, 경험 없는 상태에서 production에서 명령을 조합하지 않습니다.

복구 전에는 incident commander와 기술 책임자가 snapshot 시점, 영향 범위, 변경 동결, rollback 가능성, 외부 시스템 상태를 판단해야 합니다. 예를 들어 snapshot 이후 새 Secret rotation이 있었다면 오래된 Secret을 되돌리는 것이 application 인증에 어떤 영향을 주는지 봅니다. snapshot 이후 배포한 version이 registry에서 사라졌다면 object가 복원돼도 Pod가 image pull에 실패할 수 있습니다. restore는 시간을 되돌리는 일이 아니라, 여러 계층의 상태를 특정 시점에 맞추는 의사결정입니다.

복구 후에는 API server가 뜬 것만으로 끝내지 않습니다. node 등록, system namespace component, CoreDNS, CNI, admission controller, CRD와 operator, Secret·ConfigMap 접근, critical workload readiness, Service endpoint, ingress, storage attachment를 순서대로 확인합니다. application owner가 업무 smoke test를 하고, database·queue·외부 provider 상태와 mismatch가 없는지 봐야 합니다. control plane green과 고객 서비스 정상은 같은 말이 아닙니다.

## 업무 예시: 잘못된 RBAC와 배포 상태를 되돌려야 할 때

운영자가 잘못된 automation을 실행해 여러 namespace의 RoleBinding과 Deployment annotation을 변경했다고 가정합니다. 일부 service account는 권한을 잃고, controller는 원하는 state를 잘못 해석합니다. 이런 경우 먼저 `kubectl apply`로 개별 object를 고칠 수 있는지, Git manifest에 이전 상태가 있는지, audit log와 change record로 영향 object를 좁힐 수 있는지 봅니다. etcd restore는 가장 큰 도구이므로, 좁은 변경을 되돌리는 데 전체 cluster snapshot을 사용하는 것은 다른 정상 변경까지 되돌릴 위험이 있습니다.

반대로 etcd data corruption, control plane storage loss, 광범위한 object 삭제처럼 API object의 신뢰할 수 있는 상태를 잃었다면 snapshot restore를 검토할 수 있습니다. 이때 snapshot 시점 이후에 발생한 정상 배포·Secret rotation·autoscaler 변화도 함께 사라질 수 있으므로, 영향을 받는 team과 변경 목록을 확인합니다. restore 뒤 GitOps reconciliation이 old state와 충돌하지 않도록, controller pause·reconcile 순서·manifest version을 계획합니다.

이 사례의 핵심은 backup이 있다고 즉시 restore하는 것이 아니라, 가장 작은 안전한 복구 범위를 선택하는 것입니다. object-level recovery, Git 재적용, application-level rollback, storage restore, etcd restore는 서로 다른 위험을 가집니다. incident runbook에 선택 기준을 적어 두면 긴급 상황에서 과도한 복구를 피할 수 있습니다.

## 정기 restore drill의 구성

restore drill은 production을 멈추기 위한 행사가 아니라 backup이 실제로 사용 가능한지 확인하는 연습입니다. 격리된 network와 별도 credential을 가진 test environment에서 최근 snapshot을 복원하고, API object 수·namespace·CRD·중요 Secret metadata·system component를 확인합니다. 실제 Secret 값을 문서나 console에 노출하지 않고, 필요한 workload가 참조를 해결하는지와 권한·encryption 설정이 맞는지를 확인합니다.

drill에는 시간을 측정할 수 있지만, 이 글에서 특정 성능 수치를 주장할 수는 없습니다. 조직은 snapshot을 가져오는 시간, restore 준비 시간, control plane health 확인 시간, critical workload recovery 시간을 실제로 기록해 RTO 가정이 현실적인지 판단해야 합니다. 실패하면 snapshot 파일·key·certificate·version·storage permission·runbook 중 어디가 문제였는지 분류하고 고칩니다. restore drill을 한 번 성공했다고 영구적으로 신뢰하지 말고, Kubernetes upgrade·certificate rotation·storage 정책 변경 뒤에 다시 수행합니다.

drill 결과에는 snapshot ID, source version, target version, 실행자, 시작·종료 시각, 성공·실패한 검증 항목, 발견한 수동 단계, 후속 작업을 남깁니다. 이 기록은 다음 incident에서 누가 실행할지보다, 어떤 전제가 바뀌었는지 확인하는 데 유용합니다. 개인 노트에만 명령을 보관하면 담당자 부재가 곧 RTO 증가로 이어집니다.

## Backup 보안과 접근 권한

etcd snapshot은 cluster의 비상용 사본이면서 민감한 보안 자산입니다. object 이름, namespace, Secret, service account, certificate 참조가 포함될 수 있으므로 일반 log archive처럼 다루면 안 됩니다. 저장소 bucket은 전송·저장 시 암호화, 최소 권한 IAM, access audit, 별도 retention policy를 적용하고, backup reader와 backup writer의 권한을 분리합니다. restore 권한은 production control plane을 바꿀 수 있으므로 평상시에는 소수의 승인된 역할만 가져야 합니다.

암호화 key 관리도 snapshot 자체와 분리해 생각합니다. Kubernetes encryption-at-rest를 사용한다면 etcd data를 해독하는 데 필요한 encryption configuration과 key provider 상태가 restore 시점에도 이용 가능해야 합니다. key를 잃으면 snapshot 파일이 있어도 일부 Secret을 복구하지 못할 수 있고, key를 backup과 같은 위치에 평문으로 두면 보호 효과가 약해집니다. key rotation 절차와 snapshot 보관 기간이 서로 충돌하지 않는지 보안·platform 담당자가 함께 검토합니다.

access audit는 누가 snapshot을 생성·다운로드·복원했는지와 실패 이유를 남겨야 합니다. 단, audit log가 Secret value를 보관하면 안 됩니다. incident에서 빠른 접근이 필요하다는 이유로 개인 계정에 장기 권한을 주는 대신, break-glass 절차·승인·짧은 만료·사후 review를 두는 편이 안전합니다. 백업 경로는 평상시에는 조용하지만 침해와 재해 모두에서 높은 권한이 모이는 지점입니다.

## Cluster upgrade와 backup의 연결

Kubernetes version upgrade, control plane certificate 갱신, CNI 교체, admission webhook 추가, CRD upgrade는 etcd data와 control plane behavior를 바꿀 수 있습니다. 큰 변경 전에는 최근 정상 snapshot이 별도 storage에 있고 status 검증을 통과했는지, 복구 runbook이 현재 version과 설치 방식에 맞는지 확인합니다. upgrade 직전 snapshot이 있다고 해도 restore가 새로운 control plane binary와 호환되는지, downgrade 정책이 지원되는지는 별도 문제입니다.

변경 창에는 snapshot 생성 시각, 시작 configuration, node와 control plane 상태, version, 예상 rollback 방법을 기록합니다. 문제가 생기면 무조건 etcd restore로 돌아가기보다, component configuration rollback, version rollback, object-level correction, provider support escalation 중 가장 작은 안전한 방법을 고릅니다. snapshot restore는 마지막 보루에 가깝고, 정상 변경을 되돌리는 비용도 함께 가집니다.

upgrade 뒤에는 backup schedule도 확인합니다. 새 certificate 경로, endpoint, IAM policy, node label, storage credential이 바뀌어 backup job이 조용히 실패할 수 있습니다. deployment가 성공했다고 backup 체계가 계속 동작한다고 가정하지 말고, 다음 정상 snapshot·remote upload·alert delivery·restore test를 확인합니다. 재해 복구는 upgrade checklist의 마지막 항목이 아니라 지속되는 운영 기능입니다.

## GitOps와 snapshot의 역할 구분

GitOps는 desired manifest를 Git repository에서 선언하고 controller가 cluster와 동기화하는 방식입니다. 이 방식은 Deployment, Service, Namespace, NetworkPolicy 같은 선언형 resource를 다시 만들고 변경 이력을 검토하는 데 강점이 있습니다. 하지만 GitOps repository에 저장하지 않은 Secret, runtime controller가 만든 object, cluster-scoped 설정, 실수로 삭제된 history, external controller의 상태까지 자동으로 복원한다고 기대하면 안 됩니다.

snapshot restore 뒤 GitOps controller가 즉시 reconcile하면 old snapshot의 object와 현재 Git main branch가 충돌할 수 있습니다. incident runbook에는 controller를 언제 pause하고, 어떤 commit을 desired source로 삼으며, restore 뒤 어떤 순서로 resume할지 정합니다. Git을 source of truth로 쓰더라도 snapshot 시점과 Git commit 시점이 다르면 무엇을 우선할지 업무 판단이 필요합니다. 무조건 최신 Git을 apply하면 incident 시점 이후의 미검증 변경을 다시 넣을 수 있습니다.

GitOps와 snapshot은 중복이 아니라 서로 다른 복구 수단입니다. Git은 의도한 선언을 재구성하고 review를 남기며, snapshot은 control plane이 실제로 보던 상태를 조사·복원하는 데 도움이 됩니다. 둘 중 하나를 선택하는 대신, 어느 변경이 Git에 있어야 하는지와 emergency manual change를 어떻게 기록·반영할지 정하면 복구 시의 불일치를 줄일 수 있습니다.

## 복구 뒤 검증 순서

restore 직후 전체 application을 한 번에 scale up하지 않습니다. 먼저 control plane component와 etcd health, API server read/write, node registration을 확인합니다. 다음으로 CNI, CoreDNS, CSI, ingress controller, metrics·logging agent 같은 cluster service가 준비됐는지 봅니다. 그 뒤 namespace별 critical Deployment, StatefulSet, CronJob의 desired/ready 상태와 Service endpoint를 확인하고, 마지막으로 application owner가 로그인·조회·주문 같은 업무 smoke test를 실행합니다.

각 단계에는 성공 기준과 중단 기준이 있어야 합니다. API server가 정상인데 CoreDNS가 실패하면 application Pod가 뜨더라도 service name resolution이 안 될 수 있습니다. storage attach가 지연되면 database Pod를 강제로 재시작하지 않고 volume·zone 조건을 조사합니다. Secret restore가 old credential을 가져오면 external provider authentication이 실패할 수 있습니다. 복구 검증은 green Pod count가 아니라 dependency chain이 실제 요청을 처리하는지 확인하는 과정입니다.

복구가 끝난 뒤에는 changed state를 기록하고, backup schedule·alert·GitOps reconcile·autoscaler가 정상적인 운영 모드로 돌아갔는지 확인합니다. incident 중에 만든 임시 firewall rule, taint, scaling setting, break-glass account를 그대로 두면 다음 장애의 원인이 됩니다. 복구 완료 선언에는 서비스 정상뿐 아니라 emergency 변경 정리와 사후 review 일정도 포함합니다.

## Snapshot 실패를 탐지하고 대응하기

backup job이 매일 실행된다는 설정과 최근 사용 가능한 snapshot이 있다는 사실은 다릅니다. job scheduler가 멈추거나 certificate가 만료되거나 storage 권한이 바뀌거나 disk가 부족하면 command가 실패할 수 있습니다. 성공·실패 상태, 마지막 성공 시각, snapshot size, checksum, remote copy 완료 여부, retention job 결과를 분리해 관찰합니다. 특히 "마지막 backup이 오래됐다"는 alert는 기술 팀이 어떤 행동을 해야 하는지와 연결돼야 합니다.

실패 alert가 오면 먼저 source control plane과 storage 중 어디가 문제인지 분류합니다. etcd endpoint 접근·TLS 인증·local disk·snapshot command 오류인지, upload credential·bucket policy·network·encryption key 문제인지 확인합니다. backup failure를 고치려고 snapshot 파일을 임의 위치에 평문으로 남기거나, production certificate를 사람마다 복사하면 보안 위험이 커집니다. 승인된 break-glass 절차로 최소 범위의 접근을 사용하고, 복구 뒤 임시 권한과 파일을 정리합니다.

backup이 성공해도 restore 검증을 하지 않았다면 false confidence가 남습니다. 최근 snapshot 하나를 선택해 status와 restore drill을 주기적으로 연결하고, drill이 실패하면 backup pipeline의 성공률과 별도로 incident 또는 개선 작업으로 추적합니다. backup monitoring의 목표는 녹색 job 수가 아니라 장애 시 실제로 쓸 수 있는 복구 지점이 존재하는지 확인하는 것입니다.

## Control plane 외 구성 요소의 복구 순서

etcd는 Kubernetes state의 중심이지만, cluster가 요청을 받으려면 그 주변 구성 요소도 필요합니다. API server의 certificate와 kubeconfig, controller manager·scheduler의 static Pod manifest, CNI configuration, CoreDNS image와 config, ingress controller, CSI driver, cloud controller manager, admission webhook의 service와 certificate가 정상이어야 합니다. 설치 방식에 따라 이 파일과 credential의 위치·관리 주체가 달라지므로, runbook에는 현재 platform의 source of truth를 연결합니다.

외부 identity나 container registry도 확인합니다. restore된 ServiceAccount와 imagePullSecret이 이전 token을 참조하거나, registry가 old image tag를 retention으로 삭제했다면 Deployment object는 있어도 Pod가 ready가 되지 않습니다. cloud load balancer나 DNS가 cluster endpoint를 가리키는지, network policy가 recovery traffic을 막지 않는지, storage class가 volume을 provisioning할 수 있는지도 검증합니다. object 존재와 서비스 가능은 서로 다른 상태입니다.

복구 순서는 dependency를 따라야 합니다. network와 DNS가 준비되기 전에 application Pod를 무리하게 scale하면 image pull·service resolution 오류가 쌓여 원인 파악이 어려워질 수 있습니다. 반대로 critical database가 먼저 필요하지만 PV attach가 지연되는 경우에는 해당 layer를 관찰하고 timeout·rollback 기준을 적용합니다. 각 조직의 workload 의존성이 다르므로, generic command 목록보다 자신의 service map과 smoke test를 runbook에 넣는 것이 중요합니다.

## Multi-cluster와 Region 장애의 고려

여러 cluster를 운영한다고 해서 한 cluster의 etcd snapshot을 다른 cluster에 바로 restore할 수 있다고 가정하면 안 됩니다. cluster identity, network CIDR, ingress, storage class, CRD, node architecture, cloud integration이 다르면 object를 복원해도 예상대로 동작하지 않을 수 있습니다. DR cluster를 준비한다면 어떤 resource가 portable한지, 어떤 resource는 환경별 overlay가 필요한지, Secret·certificate·external endpoint는 어떻게 처리할지 설계합니다.

region 전체가 영향을 받는 시나리오에서는 backup bucket도 같은 region·account에만 있으면 위험합니다. cross-region copy와 immutable retention을 검토하되, 복제된 snapshot의 접근 경계와 key 관리도 같이 설계해야 합니다. 지역을 나눈다고 RTO가 자동으로 짧아지는 것은 아닙니다. DNS failover, global load balancer, database replication, application data consistency, 운영자 권한, drill frequency가 함께 준비돼야 합니다.

multi-cluster 환경에서는 어느 cluster snapshot인지 명확한 metadata가 특히 중요합니다. cluster name, environment, region, Kubernetes version, capture time, encryption key reference, source platform을 snapshot과 함께 기록합니다. 잘못된 snapshot을 다른 환경에 restore하는 사고를 막기 위해 naming rule·승인·격리된 test restore를 사용합니다. 재해 복구의 속도보다 정확한 대상 선택이 먼저입니다.

## 운영 변경의 감사와 책임

backup schedule, retention, storage policy, restore runbook은 한 팀만의 설정이 아닐 수 있습니다. platform team은 control plane과 storage를, security team은 Secret·key·access audit를, application team은 critical service smoke test를, management는 RPO·RTO 수용을 책임질 수 있습니다. 역할이 나뉘면 누가 drill 결과의 부족한 부분을 고치는지, 어떤 변경이 restore 가능성을 낮추는지 명확히 해야 합니다.

모든 restore 명령을 사람이 승인해야 한다는 뜻은 아니지만, production state를 되돌리는 변경에는 ticket·change record·승인·검증 결과가 남아야 합니다. 특히 snapshot 시점 이후 데이터가 유실될 수 있는 restore는 application owner와 data owner가 영향 범위를 이해해야 합니다. 기술적으로 가능한 복구가 업무적으로 허용되는 복구인지 따로 판단합니다.

사후 review에서는 개인 실수보다 시스템 조건을 봅니다. 왜 최신 snapshot을 찾기 어려웠는지, why runbook에 수동 단계가 많았는지, 왜 test restore가 현재 version에서 실패했는지, 왜 application smoke test가 부족했는지를 질문합니다. 이 결과를 backup job, IaC, documentation, access policy, drill cadence에 반영하면 같은 장애에서 복구 능력이 높아집니다.

## 복구 권한을 실행 가능한 절차로 바꾸기

재해가 발생했을 때 snapshot 파일이 있어도 누가 어떤 권한으로 어떤 서버에 접속해 복구를 시작하는지 모르면 RTO는 늘어난다. 평소의 Kubernetes 관리자 권한과 etcd host 접근 권한, object storage 복원 권한, load balancer 전환 권한은 한 사람에게 모두 주기 어렵고 주어서도 안 된다. 그래서 복구 문서에는 "권한이 있는 관리자"처럼 모호한 표현 대신 역할별 행동을 기록한다. 예를 들어 incident commander는 복구 선언과 중단 판단을 맡고, platform operator는 control plane 정지와 snapshot restore를 수행하며, security 담당자는 임시 접근 권한 발급과 비밀 정보 노출 여부를 확인한다. 서비스 담당자는 workload와 업무 흐름의 검증을 맡는다.

이 역할을 만든다고 해서 비상시에 승인 절차를 길게 만들자는 뜻은 아니다. 오히려 정상적인 때에 최소 권한 접근 경로를 시험해 두자는 뜻이다. 잠금 상태의 break-glass 계정, 다중 인증을 거친 비상 credential, 접근 기록이 남는 jump host처럼 평소에는 쓰지 않는 복구 경로를 준비할 수 있다. 다만 비상 계정의 비밀번호를 backup 서버와 같은 위치에 평문으로 넣는 것은 좋은 설계가 아니다. snapshot이 유출되면 cluster의 객체 정보와 함께 복구 권한까지 넘어갈 수 있기 때문이다. credential의 보관 위치, 접근 승인자, 사용 후 교체 방법을 분리해 둔다.

복구 runbook은 명령어 모음보다 의사결정 표에 가까워야 한다. control plane 전체가 멈춘 경우, 특정 namespace만 잘못 삭제된 경우, 인증서 만료로 API Server 접근만 실패한 경우는 같은 snapshot restore를 출발점으로 삼지 않는다. 먼저 영향 범위, 마지막 정상 시각, Git 또는 IaC에서 재생성 가능한지, storage data가 별도 복구를 요구하는지를 확인한다. 이 사전 판단을 문서에 넣으면 "일단 snapshot부터 복원"하는 과잉 대응을 줄일 수 있다.

## 백업 보존 기간과 삭제 정책

snapshot을 무한히 남기면 안전해 보이지만, 저장 비용과 민감한 과거 정보의 노출 면적도 함께 커진다. 보존 정책은 단순히 일 수만 정하지 말고 장애 발견 지연 시간과 감사 요구를 같이 고려해야 한다. 예를 들어 매일 생성하는 snapshot은 최근 14개, 매주 생성하는 snapshot은 최근 8개, 매월 생성하는 snapshot은 최근 12개처럼 계층을 둘 수 있다. 이 숫자는 예시일 뿐이며, 실제 서비스는 배포 주기와 법적 보존 의무, 데이터 변경량에 따라 다르게 결정해야 한다.

중요한 점은 삭제가 성공했다는 사실도 관찰해야 한다는 것이다. lifecycle rule이 잘못 설정되면 오래된 snapshot이 계속 쌓이거나 반대로 아직 필요한 최신 복구 지점이 예상보다 빨리 삭제될 수 있다. 백업 목록에서 생성 시각, 암호화 상태, checksum, 보존 만료 예정일을 주기적으로 점검하고, 삭제 작업은 가능한 한 immutable 보관 기간과 충돌하지 않게 설계한다. ransomware 같은 사고를 고려한다면 운영자가 실수로 삭제하거나 변경할 수 없는 별도 보관소와 일정 기간의 retention lock도 검토 대상이 된다.

또한 snapshot 이름에 cluster 이름과 생성 시각만 넣는 방식은 여러 환경을 운영할수록 부족해진다. environment, Kubernetes version, control plane 방식, 암호화 key 식별자, 생성 도구의 version 같은 최소 metadata를 manifest로 남겨야 한다. 그래야 오래된 파일을 찾았을 때 어느 cluster에 쓸 수 있는지, restore 전에 어떤 호환성 확인이 필요한지 판단할 수 있다. 파일명에 비밀 정보를 넣지 않는 원칙도 함께 지킨다.

## 부분 장애와 전체 복구 사이의 선택

Kubernetes에서 보이는 문제의 원인이 언제나 etcd 손상은 아니다. API Server timeout은 네트워크, 인증서, control plane 노드의 resource 압박, admission webhook 장애에서도 발생할 수 있다. scheduler가 Pod를 배치하지 못하는 경우도 quota, taint, affinity, node 상태처럼 etcd를 건드리지 않고 해결해야 하는 원인이 많다. 그러므로 incident 초기에 etcd endpoint health와 API audit log, control plane component log, node 상태를 함께 확인해야 한다.

특정 Deployment나 ConfigMap을 실수로 삭제한 상황도 전 cluster restore보다 GitOps 재동기화 또는 manifest 재적용이 더 안전한 경우가 많다. namespace 단위로 되돌리는 기능이 snapshot에 자동으로 있는 것은 아니며, 전체 snapshot restore는 삭제 이후에 만들어진 다른 팀의 변경까지 되돌릴 수 있다. 따라서 복구 후보를 세 단계로 정리해 두면 좋다. 첫째, 선언형 원본에서 재생성한다. 둘째, API 기록이나 별도 export에서 특정 객체만 복원한다. 셋째, control plane 상태 자체가 신뢰할 수 없을 때 전체 etcd snapshot restore를 검토한다. 단계가 뒤로 갈수록 영향 범위와 조정 비용이 커진다.

이 기준은 backup의 가치를 낮추는 것이 아니라 그 가치를 정확한 위치에 둔다. etcd snapshot은 cluster의 정합된 상태를 되살리는 강력한 수단이지만, 모든 Kubernetes 장애의 기본 버튼은 아니다. 팀이 선택 기준을 합의하면 밤중 장애에서 원인 확인보다 복구 명령 실행을 서두르는 일을 줄일 수 있다.

## 복구 연습 결과를 개선 작업으로 연결하기

restore drill을 한 번 성공했다고 해서 절차가 완성되는 것은 아니다. 연습 직후에는 실제 걸린 시간을 RPO와 RTO 목표에 맞춰 기록하고, 사람이 기다린 시간과 시스템이 처리한 시간을 나눠 본다. 예를 들어 snapshot 다운로드에는 3분이 걸렸지만 접근 권한을 찾는 데 20분이 걸렸다면 저장소 성능보다 runbook과 권한 위임이 우선 개선 대상이다. 반대로 restore 뒤 image pull 때문에 workload가 늦게 준비되었다면 registry 접근과 node capacity도 재해 복구 범위에 포함해야 한다.

연습 결과는 "성공" 한 줄보다 재현 가능한 증거로 남긴다. 사용한 snapshot 식별자, 시작과 종료 시각, 수행자 역할, 실패한 명령과 수정 내용, 복구 뒤 확인한 service endpoint, 남은 위험을 짧은 기록으로 남긴다. 다음 연습 때 같은 사람이 없어도 절차를 따라갈 수 있고, cluster version을 올린 뒤 이전 가정이 깨졌는지도 비교할 수 있다. 기록에 고객 데이터나 credential을 넣지 않도록 redaction 규칙도 정한다.

마지막으로 연습은 운영 cluster를 멈추는 행사일 필요가 없다. 격리된 restore 환경에서 snapshot을 복원하고 API 객체 수, 주요 namespace, 핵심 deployment ready 상태, sample request 경로를 확인하는 방식으로 시작할 수 있다. 다만 격리 환경이라도 production snapshot에 민감 정보가 들어 있다면 네트워크 egress와 접근 권한을 제한해야 한다. 안전하게 반복 가능한 연습 환경이 있어야 backup은 파일이 아니라 실제 복구 역량이 된다.

## Backup 경보를 운영 신호로 읽는 법

백업 작업은 실패했을 때만 확인하는 배치가 아니라, 재해 복구 가능성을 알려 주는 운영 신호다. 가장 기본적인 경보는 마지막 성공 snapshot 시각이 RPO를 넘었는지 확인하는 것이다. 그러나 성공 exit code 하나만 보면 충분하지 않다. 생성된 파일의 크기가 비정상적으로 작지 않은지, checksum 검증이 통과했는지, 원격 저장소에 실제로 도착했는지, 암호화가 적용되었는지, 보존 정책이 예상대로 남아 있는지를 함께 확인해야 한다. 예를 들어 local disk에 snapshot 생성은 성공했지만 object storage 업로드가 실패하면 노드 장애와 함께 복구 지점도 사라질 수 있다.

경보에는 사람이 바로 판단할 수 있는 맥락을 넣는다. 단순히 "backup failed"라고 알리기보다 cluster 이름, 마지막 정상 snapshot 시각, 실패 단계, 저장소 위치, runbook 링크, 담당 on-call을 포함하면 조사 시간을 줄일 수 있다. 다만 알림에 credential이나 snapshot의 민감한 내부 경로를 넣어서는 안 된다. 알림 채널도 보존 기간과 접근 인원을 고려해야 한다. 성공 알림을 매번 보내 경보 피로를 만들기보다, 실패·지연·검증 실패처럼 행동이 필요한 사건만 알리고 주간 요약으로 정상 상태를 확인하는 방식이 실용적이다.

또한 backup job 자체도 cluster 안의 일반 workload처럼 실패할 수 있다. CronJob이 schedule되지 않거나, node의 disk가 가득 차거나, service account 권한이 변경되거나, storage endpoint의 인증서가 바뀌는 경우가 있다. 이런 실패 조건을 restore drill과 별도로 주기적으로 점검하면, 실제 재해가 아니라 일상 운영의 작은 변경 때문에 복구 체인이 끊기는 일을 빨리 발견할 수 있다. backup의 목표는 파일 개수를 늘리는 것이 아니라 약속한 복구 지점을 계속 사용할 수 있게 하는 것이다.

## Cluster 생성 정보도 함께 보관하기

etcd snapshot만으로 복구 절차를 완전히 재현하기 어려운 이유는 cluster 바깥의 의존성이 있기 때문이다. control plane endpoint의 DNS, load balancer 설정, 노드 생성 방식, container registry 접근, CNI와 CSI의 설치 순서, cloud provider credential은 snapshot 안에 모두 들어 있지 않을 수 있다. 따라서 cluster를 처음 만들 때 사용한 IaC(Infrastructure as Code) 선언과 bootstrap 문서도 backup 전략의 일부로 다룬다. 특정 도구에 종속될 필요는 없지만, 누가 보아도 control plane 구성 방식과 외부 의존성을 확인할 수 있어야 한다.

복구 연습에서는 snapshot restore 뒤에 이 외부 의존성이 살아 있는지도 확인한다. API Server가 열렸더라도 worker node가 join하지 못하거나, Pod가 IP를 받지 못하거나, volume attach가 실패하면 서비스 복구는 끝나지 않는다. 핵심 namespace의 Pod readiness, DNS 조회, service endpoint, storage class 동작을 작은 checklist로 점검하면 etcd 상태와 서비스 상태를 혼동하지 않게 된다. 이 checklist는 환경마다 달라지므로, 가장 중요한 업무 경로부터 짧게 시작해 변경과 함께 갱신하는 것이 좋다.

이 정보를 별도 위키에만 두면 장애 시점에 최신 revision을 찾기 어려울 수 있다. snapshot metadata가 가리키는 IaC revision과 runbook revision을 함께 기록하면, 당시 cluster와 가장 가까운 구성 정보를 빠르게 열 수 있다. backup, 선언형 구성, 복구 절차는 서로 대체재가 아니라 하나의 재해 대응 사슬이다.

## 한계와 적용 기준 Q&A

### Q. etcd snapshot으로 PersistentVolume data도 복구되나요?

A. 아닙니다. snapshot에는 Kubernetes가 volume을 어떻게 참조하는지에 대한 object 정보가 들어갈 수 있지만, 실제 database file·uploaded file·block storage data는 별도 storage backup이 필요합니다. application data 복구와 control plane 복구를 하나의 절차로 착각하면 안 됩니다.

### Q. managed Kubernetes에서도 직접 etcd snapshot을 만들어야 하나요?

A. provider마다 control plane 접근 방식과 backup 책임이 다릅니다. 직접 etcd endpoint에 접근하지 못하는 서비스도 있으며, provider backup·cluster restore·IaC 재구성 기능을 써야 할 수 있습니다. 계약상 무엇이 보호되고 무엇을 사용자가 백업해야 하는지 공식 문서와 지원 조건을 확인하세요.

### Q. 매일 snapshot을 만들면 RPO가 하루인가요?

A. 최악의 경우 최근 snapshot 이후 변경을 잃을 수 있으므로 단순하게는 그렇습니다. 하지만 GitOps commit, application backup, audit log, object-level export가 일부 변경을 보완할 수 있고, snapshot upload 지연과 성공 검증 실패도 고려해야 합니다. 업무상 허용 가능한 유실 범위에서 주기와 보관·검증을 정하세요.

### Q. restore drill은 production snapshot으로 해야 하나요?

A. representative snapshot은 유용하지만 민감 data와 Secret이 포함될 수 있습니다. 격리 환경, 암호화, 최소 접근 권한, 마스킹·삭제 절차를 갖춘 경우에만 검토합니다. 가능한 범위에서 안전한 clone이나 승인된 data 처리 정책을 사용하세요.

## 마무리

Kubernetes etcd backup은 YAML을 보관하는 일보다 넓고, snapshot 파일을 만드는 일보다 좁습니다. control plane 상태를 어느 시점까지 복원할지 정하고, application data·external resource·Secret key와의 경계를 명확히 하며, 안전한 저장·alert·restore drill·업무 smoke test를 함께 준비하세요. 그러면 etcd snapshot은 재해 때만 꺼내는 파일이 아니라, cluster 변경을 책임 있게 운영하는 복구 기반이 됩니다.

<h3 class="references-heading">참고 자료</h3>

- [Kubernetes Documentation: Operating etcd clusters](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/)
- [Kubernetes Documentation: Disaster recovery](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/#disaster-recovery)
- [etcd Documentation: Disaster recovery](https://etcd.io/docs/v3.6/op-guide/recovery/)
- [Kubernetes Documentation: Encrypting confidential data at rest](https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/)
