---
layout: post
title: "Kubernetes Admission Control을 설계하는 법: 요청 검증·정책·예외·배포 경계"
category: Infrastructure
description: "Kubernetes API 요청이 저장되기 전의 admission 단계에서 무엇을 검증하고 변경할 수 있는지, 정책을 안전하게 배포·운영하는 방법을 정리합니다."
---

<section class="quick-answers"><h2>먼저 답하기</h2><p><strong>Q. admission policy는 배포를 막는 보안 규칙인가요?</strong><br>A. 보안만을 위한 기능은 아닙니다. namespace label, resource limit, image registry, owner 정보처럼 클러스터 운영에 필요한 불변 조건을 API 요청이 저장되기 전에 일관되게 검증하는 경계입니다.</p><p><strong>Q. 모든 규칙을 바로 Deny로 적용해도 되나요?</strong><br>A. 안 됩니다. 기존 workload와 예외를 먼저 관찰하고, audit·경고·canary 범위를 거쳐 영향을 확인해야 합니다. 정책 오류는 정상 배포를 막을 수 있으므로 rollback과 소유자를 함께 설계해야 합니다.</p></section>

Kubernetes에서 Pod, Deployment, Service 같은 리소스를 만들거나 바꾸는 일은 결국 Kubernetes API Server에 요청을 보내는 일입니다. `kubectl apply`, Helm, GitOps controller, CI pipeline, operator 모두 같은 API 경로를 거칩니다. 그래서 image tag를 고정하고 싶거나, privileged container를 막고 싶거나, 모든 workload에 team label을 요구하고 싶을 때 각 도구에 별도의 규칙을 넣는 방식은 쉽게 어긋납니다. admission control은 API Server가 object를 저장하기 전에 공통 규칙을 적용하는 장소입니다.

이 글의 핵심은 정책을 많이 쓰는 것이 아닙니다. 어떤 규칙이 platform의 공통 계약인지, 어떤 규칙은 팀의 선택인지, 어떤 예외가 필요한지 구분하는 것입니다. 잘 설계된 admission 정책은 배포가 왜 거절됐는지 설명하고, 개발팀이 안전한 기본값을 따라가게 돕습니다. 반대로 실제 workload를 모른 채 엄격한 규칙을 한꺼번에 켜면, 장애 대응과 긴급 배포에서 policy를 통째로 꺼 버리는 결과를 만들 수 있습니다.

## 먼저 알아둘 기반 기술

Kubernetes control plane은 원하는 상태를 API object로 저장하고, 여러 controller가 그 상태를 실제 cluster 상태로 맞추는 구조입니다. 사용자가 Deployment manifest를 적용하면 API Server는 요청의 인증과 권한을 확인하고, object가 유효한지 검증한 뒤 etcd에 저장합니다. 이후 Deployment controller, ReplicaSet controller, scheduler, kubelet이 각자 역할을 수행합니다. admission control은 controller가 실행되기 전, API Server의 요청 처리 과정에 위치합니다.

인증(authentication)은 요청 주체가 누구인지 확인하는 단계입니다. client certificate, service account token, OIDC 토큰 등이 identity를 제공합니다. 인가(authorization)는 그 주체가 특정 namespace에서 Deployment를 만들 수 있는지처럼 동작 권한을 확인하는 단계이며, Kubernetes에서는 RBAC(Role-Based Access Control)를 자주 사용합니다. admission은 인증·인가를 통과한 요청이라도 조직의 정책과 object 내용에 맞는지 판단합니다. Deployment를 만들 권한이 있다고 해서 `hostNetwork: true`나 privileged container를 만들 권한까지 자동으로 인정하는 것은 아닙니다.

mutating admission은 object를 저장하기 전에 값을 추가하거나 수정합니다. 예를 들어 label을 기본으로 넣거나, sidecar를 주입하거나, image pull policy를 조직 기본값으로 바꾸는 방식입니다. validating admission은 object가 정책을 지키는지 확인하고, 맞지 않으면 이유와 함께 거절합니다. 두 유형을 함께 쓰면 편하지만, mutation이 숨겨진 동작이 되면 manifest만 보고 최종 상태를 이해하기 어렵습니다. 어떤 값이 사용자가 선언한 것인지, platform이 넣은 기본값인지 관찰할 수 있게 해야 합니다.

CRD(Custom Resource Definition)는 cluster에 새로운 API resource를 추가하는 방법입니다. operator는 CRD object를 보고 database, certificate, network 같은 외부 상태를 관리할 수 있습니다. admission 정책은 기본 Pod만이 아니라 CRD에도 적용할 수 있지만, CRD의 schema와 lifecycle을 이해하지 못하면 정상 operator 동작을 막을 수 있습니다. policy 대상은 cluster에 존재하는 모든 API가 아니라, 실제로 ownership과 위험을 설명할 수 있는 resource부터 좁게 시작하는 편이 안전합니다.

## admission 단계에서 해결할 문제와 아닌 문제

admission에 잘 맞는 문제는 object 자체만 보고 결정할 수 있고, cluster 전체에서 일관되게 지켜야 하는 불변 조건입니다. 예를 들어 production namespace에서 `latest` image tag를 금지하기, Pod에 CPU·memory request와 limit를 요구하기, 승인된 registry만 사용하기, 외부 노출 Service에 owner label을 요구하기가 있습니다. 이 규칙들은 CI lint에서 잡을 수도 있지만, CI 외부의 kubectl·Helm·controller 요청까지 같은 기준으로 다루려면 API 경계가 유리합니다.

반면 실제 서비스가 정상인지, database migration이 완료됐는지, 특정 endpoint의 응답 시간이 목표 안인지 같은 문제는 admission만으로 판단하기 어렵습니다. admission은 요청 시점의 object를 보며, 실행 뒤에 발생하는 network 연결·용량 부족·외부 provider 오류를 알지 못합니다. 이런 문제는 readiness probe, monitoring, deployment controller, integration test, runtime policy와 함께 다뤄야 합니다. admission policy를 만능 보안·품질 도구로 보면, 실행 시점 문제를 manifest field만으로 억지로 표현하게 됩니다.

정책은 business rule을 모두 넣는 곳도 아닙니다. "결제 서비스는 월말에만 배포한다"처럼 시간·승인·업무 흐름에 따라 바뀌는 규칙은 GitOps workflow나 change management가 더 적합할 수 있습니다. admission에 이런 규칙을 넣으면 API Server가 외부 일정·티켓 시스템에 의존하게 되고, 긴급 상황에서 예외를 처리하기 어려워집니다. admission은 platform의 작고 안정적인 안전 경계에 집중하고, 자주 바뀌는 업무 절차는 다른 계층에 두는 것이 유지하기 쉽습니다.

## 정책을 분류하는 실용적인 기준

첫 그룹은 안전 기본값입니다. non-root 실행, privilege escalation 금지, 불필요한 Linux capability drop, read-only filesystem처럼 일반 workload가 기본으로 따라야 하는 설정이 여기에 속합니다. 다만 node agent, storage driver, network plugin 같은 system workload는 다른 요구가 있을 수 있습니다. 모든 namespace를 같은 규칙으로 묶기보다 platform system namespace와 일반 application namespace를 분리하고, 예외 workload의 owner·이유·재검토 기간을 남기는 것이 필요합니다.

둘째는 운영 가능성 규칙입니다. resource request·limit, liveness와 readiness probe, label, PodDisruptionBudget, image digest처럼 capacity planning·장애 대응·추적에 도움이 되는 항목입니다. 이 규칙은 "보안 위험"이라는 말보다 "이 값이 없을 때 누가 어떤 운영 결정을 못 하는가"를 설명하면 팀의 수용성이 높습니다. 예를 들어 owner label은 장애 때 책임자를 찾고, request는 scheduler가 node 배치를 판단하며, readiness는 traffic을 줄 시점을 판단하는 입력입니다.

셋째는 공급망과 외부 접근 규칙입니다. approved registry, 서명된 image, hostPath volume, host namespace, privileged mode, service account token mount, egress 허용 같은 항목은 영향이 크지만 service 유형에 따라 예외가 생깁니다. 처음부터 한 정책에 모두 넣지 말고 위험도와 검증 방법을 나눕니다. image registry는 audit부터 시작하고, privileged mode는 system namespace를 제외한 application namespace에서 deny하는 식으로 단계적으로 적용할 수 있습니다.

넷째는 메타데이터 규칙입니다. cost center, data classification, owner, environment, ticket ID, version 같은 label·annotation은 보안 기능처럼 보이지 않지만 운영에 큰 차이를 만듭니다. 다만 값이 형식만 맞고 사실과 다르면 도움이 되지 않습니다. required label을 강제할 때는 값의 형식과 source of truth를 정하고, CI나 GitOps repository에서 자동으로 채울 수 있게 해야 합니다. 사람이 매번 입력해야 하는 metadata가 많아지면 임의 문자열과 형식상 통과를 늘릴 뿐입니다.

## 구체적 업무 예시: production namespace의 배포 계약

`production` namespace에 주문 API를 배포한다고 가정해 보겠습니다. platform 팀은 최소한의 공통 계약을 정합니다. container는 non-root로 실행하고 privilege escalation을 금지한다. image는 사내 registry와 digest를 사용한다. CPU·memory request와 limit가 있다. service owner와 data classification label이 있다. 이 계약은 order team만의 규칙이 아니라, node 보안·capacity·장애 대응을 위해 모두가 필요한 정보입니다.

처음에는 정책을 audit mode로 둡니다. 실제 manifest를 수집해 어떤 field가 빠졌는지, Helm chart가 어떤 기본값을 넣는지, migration job과 monitoring agent가 어떤 예외를 요구하는지 확인합니다. 이 단계에서 발견한 위반을 개발팀의 실수로 취급하면 정책은 반발을 만듭니다. chart template의 기본값이 없었는지, documentation이 부족했는지, platform의 base image가 non-root를 지원하지 않는지 원인을 나눠야 합니다.

그 다음 risk가 낮은 규칙부터 enforce합니다. owner label과 approved registry처럼 수정이 쉽고 영향이 명확한 조건을 먼저 deny로 전환할 수 있습니다. capability나 hostPath 같이 exception이 많은 규칙은 namespace scope와 exception process를 정한 뒤 적용합니다. 예외는 `policy-exception: true` 같은 label 하나로 끝내지 않습니다. 어떤 규칙에 대한 예외인지, 누가 owner인지, 언제 재검토하는지, cluster-wide 위험이 있는지 기록해야 합니다.

배포가 거절되면 개발자는 오류 메시지로 필요한 행동을 알 수 있어야 합니다. "denied by policy"보다 "production workload에는 resources.requests.memory가 필요합니다. standard Helm values의 resources preset을 사용하거나, owner와 예상 사용량을 지정하십시오"가 낫습니다. 정책 메시지는 platform 팀의 내부 구현이 아니라 사용자 interface입니다. 정확한 field path, 이유, 안전한 해결책, 문서 링크를 제공하면 긴급한 경우에 policy를 우회하려는 압력을 줄일 수 있습니다.

## 예외는 규칙의 실패가 아니라 운영 대상이다

모든 workload를 한 policy로 다루기 어려운 이유는 Kubernetes가 다양한 수준의 software를 실행하기 때문입니다. CSI driver, CNI plugin, node monitoring agent는 host path나 추가 권한이 필요할 수 있습니다. 이 예외를 모른 척하고 policy를 강제하면 cluster 기능을 망가뜨리고, 반대로 모든 namespace에 예외를 허용하면 일반 application의 경계가 사라집니다. 예외의 존재보다 예외가 어디에 있고 왜 필요한지 보이지 않는 상태가 위험합니다.

예외 설계에는 범위, 기간, owner, 검토가 필요합니다. 범위는 특정 namespace·service account·workload label·resource kind처럼 좁게 정합니다. 기간은 일시적인 migration이나 vendor issue 대응이라면 만료일을 가집니다. owner는 policy를 만든 platform 팀이 아니라 예외 workload의 기술적 책임자까지 포함합니다. 검토에서는 예외가 아직 필요한지, upstream update나 architecture 변경으로 줄일 수 있는지, 같은 이유의 예외가 늘고 있지는 않은지 확인합니다.

긴급 배포를 위한 bypass도 미리 설계합니다. incident에서 API Server policy를 통째로 끄면 다른 팀의 안전 경계까지 함께 사라집니다. 대신 제한된 운영 role이 특정 namespace에서 짧은 시간 동안 승인된 exception object를 만들게 하거나, canary namespace에서 먼저 검증하는 방법을 둘 수 있습니다. bypass 사용은 audit event와 ticket를 남기고, incident가 끝난 뒤 정상 정책으로 돌아왔는지 확인하는 절차가 있어야 합니다.

## 정책 변경을 배포하는 순서

admission policy도 software처럼 version과 rollout이 필요합니다. 새로운 규칙을 만들면 먼저 정책 자체가 정상 manifest와 예외 manifest를 올바르게 분류하는지 테스트합니다. positive test는 위험한 object가 거절되는지, negative test는 정상 object가 통과하는지 확인합니다. 특히 field가 없는 object, 여러 container가 있는 Pod, init container, ephemeral container, namespace label이 없는 경우처럼 경계값을 넣어야 합니다.

다음에는 제한된 namespace나 canary cluster에서 audit를 수집합니다. production 전체에서 처음 보는 chart·operator·legacy workload가 있을 수 있으므로, 위반 수와 object 종류만 보지 말고 실제 deployment 영향도 확인합니다. false positive가 나오면 단순히 규칙을 약하게 하기보다 policy가 표현하려는 위험과 해당 workload의 실제 요구를 다시 비교합니다. 필요한 경우 workload 구조를 고치거나 더 좁은 exception을 만들 수 있습니다.

enforce 전환은 변경 창과 rollback 조건을 정해 진행합니다. 예상보다 많은 deployment가 거절되거나 critical workload의 autoscaling이 막히면 어떤 시점에 audit mode로 되돌릴지, 누가 결정할지, 어떤 로그를 보며 영향 범위를 확인할지 준비합니다. policy를 삭제하는 rollback은 빠르지만, 이전 위험한 object가 다시 들어올 수 있습니다. scope를 좁히거나 특정 rule만 비활성화하는 rollback이 가능한지 설계 단계에서 생각해야 합니다.

GitOps 환경에서는 policy manifest와 예외 object를 application manifest와 같은 repository 또는 연결된 repository에서 review할 수 있습니다. 누가 policy를 바꿨고 어떤 workload가 영향을 받는지 diff로 보이게 하면, cluster에서 직접 수정하는 것보다 재현성이 높습니다. 다만 Git repository에 secret이나 broad bypass token이 들어가지 않도록 하고, policy controller가 자기 자신의 업데이트를 막지 않는 bootstrap 경로도 확인해야 합니다.

## webhook 기반 정책의 가용성 경계

외부 admission webhook은 조직의 고유한 규칙을 코드로 구현할 수 있게 하지만, API Server가 object 요청을 처리할 때 webhook과 통신해야 한다는 새로운 의존성을 만듭니다. webhook Pod가 내려가거나 DNS가 실패하거나 certificate가 만료되면, 정상 deployment도 느려지거나 거절될 수 있습니다. 따라서 webhook은 단순한 policy 서비스가 아니라 control plane의 일부로 다뤄야 합니다. replica 수, Pod disruption, network path, certificate rotation, timeout, readiness를 application보다 더 엄격하게 확인할 이유가 있습니다.

`failurePolicy`의 선택에는 trade-off가 있습니다. 장애가 나면 요청을 거절하는 fail-closed는 위험한 object가 policy 검사 없이 들어오는 것을 막지만, webhook 자체의 장애가 배포 중단으로 번질 수 있습니다. 장애가 나면 허용하는 fail-open은 control plane 가용성을 유지하지만, 그 시간에는 정책 경계가 약해집니다. 어떤 값이 항상 맞는 것은 아닙니다. privileged workload 차단처럼 위험이 큰 규칙, label 형식처럼 운영 편의 규칙, audit 용도 규칙을 같은 failure 정책으로 묶지 말고 영향과 대체 통제를 기준으로 나눠야 합니다.

webhook 응답 시간도 설계 대상입니다. 원격 database나 외부 ticket 시스템을 조회해 정책을 판단하면 한 API 요청의 latency가 외부 시스템 장애에 묶입니다. 가능한 한 object와 namespace label, 사전에 동기화된 작은 정책 데이터처럼 API Server 가까이에서 결정할 수 있는 입력만 사용합니다. 필요한 lookup이 있다면 cache와 명확한 timeout을 두고, webhook이 느려졌을 때 어떤 요청을 어떻게 처리할지 테스트합니다. 검증 규칙이 복잡하다는 이유로 control plane에 무한 대기 의존성을 추가해서는 안 됩니다.

webhook 자신이 정책에 의해 막히는 순환도 확인해야 합니다. 새 image registry 규칙을 켰더니 policy webhook의 image가 허용 목록 밖에 있거나, resource limit 규칙을 켰더니 webhook chart가 기준을 만족하지 않아 재배포할 수 없는 경우가 있습니다. bootstrap workload, system namespace, policy rollout 순서를 명시하고, 새로운 규칙을 켜기 전에 webhook과 controller의 manifest를 먼저 검증합니다. 이 예외는 정책을 무력화하기 위한 구멍이 아니라 control plane을 회복하기 위한 제한된 경로여야 합니다.

## 관찰성과 정책 효과 측정

정책을 적용한 뒤에는 deny count만 보면 안 됩니다. 어떤 namespace·resource·rule·배포 도구에서 거절이 발생하는지, 해결까지 얼마나 걸리는지, 같은 예외가 반복되는지, bypass 사용이 늘고 있는지를 함께 봅니다. deny가 많다는 것은 정책이 잘 작동한다는 뜻일 수도 있고, base chart와 문서가 현실을 따라가지 못한다는 뜻일 수도 있습니다. 반대로 deny가 전혀 없으면 규칙이 불필요하다는 의미일 수도, audit와 로그 수집이 누락됐다는 의미일 수도 있습니다.

admission 결정에 request ID, policy revision, rule name, 대상 namespace와 object kind를 남기면 deployment 실패를 추적하기 쉽습니다. 단, manifest 전체나 secret 값을 로그에 복사하면 정책 로그가 민감한 정보 저장소가 됩니다. 관찰에 필요한 metadata와 에러 분류를 우선 남기고, 상세 object는 권한 있는 사람이 필요할 때 Kubernetes API에서 조회하게 합니다. 로그 보존 기간과 접근 권한도 일반 application 로그와 동일하게 설계해야 합니다.

정책 변경의 성공 지표는 보안 사건이 없었다는 것 하나가 아닙니다. 표준 Helm chart를 사용하는 workload 비율, owner label이 있는 resource 비율, 만료된 exception 수, privileged 설정의 추세, policy 거절을 수정하는 평균 시간이 실용적인 신호가 될 수 있습니다. 이 수치를 팀 평가에 바로 쓰면 사람들이 bypass나 임의 label로 지표를 맞출 수 있으므로, 개선의 방향을 찾는 운영 지표로 다루는 것이 낫습니다.

정기 리뷰에서는 오래된 rule과 exception을 함께 봅니다. Kubernetes 버전이나 runtime 기본값이 바뀌어 더 이상 필요한 규칙이 있을 수 있고, 반대로 새 API field가 생겨 기존 규칙이 빈틈을 가질 수 있습니다. policy test fixture에 새 manifest 형태를 추가하고, platform·security·application owner가 실제 영향과 예외를 검토하면 정책이 문서상으로만 엄격해지는 일을 줄일 수 있습니다.

## 팀이 정책을 사용하게 만드는 문서와 인터페이스

개발팀 입장에서 admission policy는 오류 메시지로 처음 만나는 platform 기능입니다. 따라서 policy 문서는 rule 이름만 나열하기보다 왜 필요한지, 어느 대상에 적용되는지, 안전한 기본 manifest는 무엇인지, exception은 어떻게 신청하는지, 긴급 상황에는 어떤 절차를 쓰는지를 보여줘야 합니다. 특히 "이 설정은 보안팀이 요구한다"는 설명보다, `readinessProbe`가 없으면 rollout 중 traffic을 안전하게 옮길 수 없고 resource request가 없으면 scheduler가 capacity를 계획할 수 없다는 설명이 더 행동 가능한 안내가 됩니다.

표준 template와 자동 기본값을 제공하면 개발자는 policy를 외워서 통과할 필요가 없습니다. service scaffold, Helm chart, Kustomize base에 owner label, resource block, security context, probe 예제를 넣고, 팀은 필요한 값만 채우게 합니다. mutating policy를 사용할 때도 최종 object를 `kubectl get`이나 GitOps diff에서 확인할 수 있어야 합니다. 숨겨진 기본값은 편리하지만, troubleshooting과 compliance에서 예상하지 못한 동작을 만들 수 있습니다.

예외 요청 양식은 최소한으로 유지하되 핵심 정보는 빠뜨리지 않습니다. 대상 workload, 필요한 field, 업무 이유, 대체할 수 없는 이유, owner, 만료일, 테스트한 환경을 받으면 reviewer가 context 없이 승인하는 일을 줄일 수 있습니다. 예외를 받은 workload는 dashboard나 inventory에서 보이게 하고, 만료 전에 owner에게 알립니다. 승인 절차가 너무 느리면 shadow deployment나 broad role 요청을 낳으므로, 위험도에 따라 self-service 가능한 낮은 위험 예외와 별도 검토가 필요한 높은 위험 예외를 구분할 수 있습니다.

## policy 테스트의 구체적 구성

정책은 선언형 manifest이지만 논리가 있습니다. 그래서 sample manifest 몇 개가 통과했다는 사실만으로 충분하지 않습니다. 각 rule에는 통과해야 하는 최소 manifest, 거절돼야 하는 위험 manifest, 예외가 적용된 manifest, field가 없는 manifest, 여러 container·init container·ephemeral container가 있는 manifest를 둡니다. image 규칙이라면 tag, digest, registry prefix, init container image까지 포함합니다. resource 규칙이라면 CPU만 있는 경우, memory만 있는 경우, limit과 request의 관계가 잘못된 경우도 넣습니다.

namespace selector와 object selector는 특히 주의합니다. production label이 없는 namespace에 정책이 적용되지 않거나, team label 하나를 붙여 정책을 피해 갈 수 있다면 의도한 경계와 다릅니다. selector가 바뀌는 namespace lifecycle, system namespace, test namespace, migration job namespace를 fixture로 만들고 실제 cluster label과 같은 값을 사용합니다. policy가 특정 namespace에 적용되지 않는 것이 의도된 예외라면 그 이유와 owner를 테스트 이름으로 드러내는 편이 좋습니다.

테스트는 policy engine만이 아니라 실제 API 요청 경로에서도 해야 합니다. template rendering 뒤 object가 어떤 모양이 되는지, controller가 생성하는 child object에도 policy가 적용되는지, GitOps controller identity에 필요한 RBAC가 있는지 확인합니다. admission 거절 메시지가 CI log에 이해 가능하게 남는지, rollout 도중 변경한 policy가 기존 Pod 교체를 막지 않는지도 staging에서 살펴야 합니다. 이렇게 하면 policy는 security review용 YAML이 아니라 배포 시스템의 실제 의존성이 됩니다.

## resource와 workload lifecycle을 함께 보기

admission 정책은 생성 요청만 검사하는 것처럼 보이지만, update·delete·subresource 요청에서도 중요한 경계가 생깁니다. Deployment의 image를 바꾸는 update, scale subresource로 replica 수를 늘리는 요청, ephemeral container를 추가하는 debug 요청은 같은 workload의 위험을 바꿀 수 있습니다. create만 막고 update를 놓치면 처음에는 안전했던 object가 나중에 위험한 설정으로 바뀔 수 있습니다. 반대로 모든 update를 같은 수준으로 검사하면 controller가 정상적으로 status를 갱신하는 일까지 방해할 수 있습니다.

따라서 rule마다 어떤 operation과 API resource를 볼지 명시합니다. image registry 규칙은 Pod template가 바뀌는 create·update에 적용하고, owner label 규칙은 생성 시점에만 강제할 수 있습니다. debug container는 일반 container와 다른 권한·image·lifecycle을 가질 수 있으므로 별도 검토 대상입니다. incident 조사에 ephemeral container가 필요한 경우에도 누가 어느 namespace에서 만들 수 있는지, 어떤 image를 쓸 수 있는지, 생성 기록을 어떻게 남기는지 정해야 합니다.

Job과 CronJob도 일반 Deployment와 같은 방식으로만 보지 않습니다. migration이나 maintenance job은 짧게 실행되고 끝나지만, 높은 database 권한·파일 접근·네트워크 권한을 요구할 수 있습니다. 기본 workload 규칙을 무작정 예외 처리하기보다, Job에 필요한 resource limit·service account·TTL·owner·image provenance를 별도 계약으로 두는 편이 낫습니다. 이미 끝난 Job이 cluster에 남아 민감한 command나 environment reference를 보여 주지 않는지도 lifecycle 정책에 포함합니다.

delete 요청을 항상 차단할 수는 없지만, 중요한 namespace나 protection label이 있는 resource에 대해 승인된 identity만 삭제하도록 RBAC와 admission을 보완할 수 있습니다. application owner가 자기 Deployment를 delete할 수 있어야 하는 경우에도, shared platform component나 backup CRD는 다른 보호 수준이 필요할 수 있습니다. deletion protection은 영구적으로 막는 장치가 아니라, 실수와 자동화 오류가 되돌릴 수 없는 영향으로 번지기 전에 의도를 확인하는 경계입니다.

## multi-cluster와 정책 일관성

개발·staging·production cluster가 분리돼 있으면 policy도 환경마다 달라질 수 있습니다. development에서 빠르게 실험하기 위한 규칙과 production에서 data·network·workload safety를 지키는 규칙은 동일할 필요가 없습니다. 하지만 차이가 문서화되지 않으면 개발에서 통과한 manifest가 production에서 처음 거절되고, 팀은 policy를 장애 원인으로만 인식하게 됩니다. 공통 baseline과 환경별 추가 규칙을 분리하고, 어떤 rule이 어느 cluster에서 enforce인지 repository와 dashboard에서 보여 주는 것이 좋습니다.

policy bundle의 version을 cluster마다 추적하면 rollout 문제를 줄일 수 있습니다. production에서 문제가 발생했을 때 어떤 policy revision이 적용됐는지, staging에서 어떤 revision으로 검증했는지 알 수 있어야 합니다. GitOps controller가 여러 cluster에 정책을 배포한다면 cluster별 overlay와 selector가 의도대로 작동하는지 test fixture로 확인합니다. 한 cluster의 긴급 exception이 다른 cluster에 복사되지 않도록 scope도 명시합니다.

multi-cluster에서 특히 주의할 점은 중앙 policy 서비스가 모든 cluster API 요청을 막는 구조입니다. 하나의 webhook endpoint나 certificate authority에 모든 cluster가 의존하면 중앙 장애가 여러 환경의 배포 중단으로 퍼질 수 있습니다. cluster-local deployment, 독립적인 failure domain, 정책 cache, 제한된 timeout을 검토하고, 중앙 control plane이 장애일 때 각 cluster가 어떤 안전 상태로 동작하는지 정합니다. 운영 편의와 blast radius 사이의 선택을 문서로 남겨야 합니다.

## 안전한 기본값과 자율성의 균형

platform 팀이 모든 manifest field를 정하면 application 팀은 service 특성에 맞게 조정할 수 없고, 반대로 아무 기본값도 없으면 팀마다 security context와 resource 설정이 달라집니다. 좋은 기본값은 대부분의 workload가 수정 없이 안전하게 시작할 수 있게 하되, 정당한 차이를 표현할 좁은 extension point를 제공합니다. 예를 들어 기본 service account는 자동 token mount를 끄고, 필요한 API 접근은 명시적 role과 account로 제공할 수 있습니다.

자율성은 policy를 무시할 권한이 아니라, 정해진 계약 안에서 필요한 값을 선택하는 능력입니다. 팀이 CPU·memory request를 스스로 정하되 최소 format과 합리적인 범위를 policy가 확인하고, image registry는 승인된 domain만 허용하되 digest는 팀이 선택하게 할 수 있습니다. 기본 Helm chart와 문서가 이런 선택을 쉽게 만들면, policy는 중앙 통제 수단보다 self-service platform 기능에 가까워집니다.

정책의 효과는 bypass 요청 수로도 점검할 수 있습니다. 같은 팀이 같은 rule에 반복 예외를 요청한다면, 그 팀이 정책을 이해하지 못했다기보다 template나 rule가 실제 workload 모델과 맞지 않을 수 있습니다. 반대로 위험한 예외를 너무 쉽게 허용하면 policy는 형식만 남습니다. exception 데이터와 incident 회고를 바탕으로 standard를 개선하고, 예외를 줄일 수 있는 base image·library·chart 기능을 제공하는 선순환이 필요합니다.

## 실제 도입의 작은 시작점

처음부터 privileged, image, resource, label, network, secret, 모든 CRD를 한꺼번에 다루면 정책의 원인과 영향 범위를 이해하기 어렵습니다. 한 cluster의 일반 application namespace에서 owner label과 approved registry처럼 의미가 명확한 두 규칙부터 시작할 수 있습니다. audit 결과를 일주일 정도 모아 어떤 chart가 수정되어야 하는지 확인하고, 표준 values와 오류 메시지를 마련한 뒤 enforce합니다. 이 과정에서 필요한 예외가 무엇인지도 자연스럽게 드러납니다.

다음 단계로 resource request와 security context를 추가할 수 있습니다. 이 규칙은 workload가 실제로 사용하는 값과 base image 동작을 확인해야 하므로, staging rollout과 rollback을 준비합니다. container가 root로 실행되는 이유가 legacy image 때문이라면 단순 exception보다 image를 고치는 작업을 backlog에 넣습니다. request를 임의의 큰 값으로 채우는 방식이 늘어난다면 capacity policy와 usage 관찰이 함께 필요합니다.

정책 도입의 성공은 모든 거절을 없애는 데 있지 않습니다. 명확한 위험은 자동으로 막고, 정상 workload는 표준 template로 쉽게 통과하며, 정당한 예외는 추적되고 시간이 지나면 줄어드는 상태가 목표입니다. 이 상태에 도달하려면 platform 팀만 policy YAML을 관리하는 구조보다, application team이 배포 경험과 예외 이유를 피드백할 통로가 있어야 합니다.

마지막으로 policy는 실제 incident와 major upgrade 뒤에 다시 확인합니다. 새로운 Kubernetes API나 runtime behavior가 생기면 selector와 rule가 놓치는 field가 생길 수 있고, 장애 대응에서 반복된 bypass는 기본 계약에 빈틈이 있다는 신호일 수 있습니다. 작은 규칙을 검증 가능한 방식으로 계속 고치는 편이, 완벽해 보이지만 아무도 이해하지 못하는 거대한 정책 집합보다 안전합니다.

정책을 설명하는 교육도 기술적인 운영 항목입니다. 새 팀원이 namespace에 첫 서비스를 올릴 때 어떤 manifest가 통과하는지, deny 메시지를 어디서 확인하는지, exception을 어떤 기준으로 요청하는지 모르면 검증 규칙은 갑작스러운 장애처럼 느껴집니다. 짧은 onboarding 문서와 작동하는 sample repository, 자주 묻는 오류의 해결 예시를 제공하면 platform 기능을 사용하는 비용을 낮출 수 있습니다. 이 문서도 실제 policy revision과 함께 갱신되어야 합니다.

또한 policy가 이미 저장된 object를 자동으로 고쳐 주지 않는다는 점을 기억해야 합니다. 새 규칙을 enforce해도 과거에 생성된 workload는 그대로 남을 수 있고, 다음 update 또는 rollout에서만 검증될 수 있습니다. 기존 inventory를 별도로 점검해 위험한 설정을 migration 계획으로 고치고, 수정 우선순위와 owner를 정해야 합니다. admission은 새 drift를 막는 경계이고, 기존 drift를 없애는 작업은 별도의 관찰·변경·검증 과정입니다.

정책을 도입한 뒤에는 cluster 사용자에게 단순한 금지 목록 대신 선택의 이유를 공유합니다. image digest가 필요한 이유는 재현 가능한 배포와 공급망 추적이고, resource request가 필요한 이유는 scheduler와 capacity 계획이며, security context가 필요한 이유는 한 workload의 권한이 node 전체로 번지는 위험을 줄이기 위해서입니다. 이유를 이해하면 개발자는 오류를 피하는 값만 넣는 대신 서비스 특성에 맞는 안전한 설정을 제안할 수 있습니다. policy는 플랫폼과 application 팀 사이의 계약이므로, 변경 사항과 예외의 비용을 함께 드러내는 것이 장기 운영에 중요합니다.

정책이 모든 장애를 예방하지는 않지만, 위험한 배포 구성이 cluster에 들어오는 시점을 앞당겨 발견하게 합니다. 이 조기 피드백이 CI의 빠른 lint, staging의 실제 API 검증, production의 제한된 rollout과 이어질 때 운영자는 배포 실패를 사후 복구가 아니라 사전 설계 문제로 다룰 수 있습니다.

## 한계와 적용 기준 Q&A

### Q. Helm values에서 이미 검증하는데 admission이 필요한가요?

A. Helm chart validation은 chart를 사용하는 흐름에는 좋지만, 직접 `kubectl`을 쓰는 요청, operator가 만든 object, 다른 chart는 놓칠 수 있습니다. admission은 cluster API 경계에서 마지막 공통 검증을 제공합니다. 둘은 중복이 아니라 역할이 다릅니다. chart는 개발자가 빠르게 수정할 수 있는 안내를, admission은 모든 경로에 적용되는 불변 조건을 맡습니다.

### Q. policy가 복잡해지면 API Server 성능에 문제가 없나요?

A. admission은 요청 경로에 있으므로 policy 수와 외부 webhook 의존성이 늘면 배포 지연이나 장애 전파를 만들 수 있습니다. 필요한 규칙만 두고, 가능한 한 선언적인 내장 검증을 우선하며, webhook의 timeout·failure policy·가용성을 테스트해야 합니다. network 호출에 의존하는 policy는 webhook 장애가 cluster 배포 장애가 될 수 있다는 점을 특히 고려해야 합니다.

### Q. 모든 보안 설정을 admission에서 막으면 runtime 보안 도구는 필요 없나요?

A. 필요합니다. admission은 요청 시점의 manifest를 보지만, 실행 중 process 동작·network 연결·kernel 취약점·credential 유출은 별도 문제입니다. image scanning, runtime detection, network policy, RBAC, patch 관리, monitoring이 함께 필요합니다. admission은 이 계층들을 대체하는 것이 아니라 위험한 설정이 시작부터 들어오는 것을 줄이는 한 층입니다.

## 도입 체크리스트

먼저 현재 cluster에서 공통으로 필요한 안전·운영 계약을 목록화합니다. 각 항목에 대해 대상 resource·namespace·위험·owner·예외 여부·검증 방법을 정하고, audit mode에서 실제 위반을 수집합니다. 오류 메시지와 표준 chart 값을 마련한 뒤 낮은 위험 규칙부터 enforce합니다. 정책과 예외의 변경은 version control과 review를 거치며, 만료된 exception을 정기적으로 제거합니다. 마지막으로 policy webhook이나 controller가 실패했을 때 deployment에 미치는 영향과 rollback 절차를 연습합니다.

Kubernetes admission control은 manifest를 엄격하게 만드는 장치만이 아닙니다. cluster에서 어떤 workload가 어떤 기본값과 경계를 지켜야 하는지 공통 언어로 만들고, 그 계약을 API 요청마다 일관되게 적용하는 방법입니다. 작은 정책을 관찰·설명·검증 가능한 방식으로 시작하면, 배포를 막기 위한 규칙이 아니라 안전하게 빠르게 배포하기 위한 platform 기능이 됩니다.

<h3 class="references-heading">참고 자료</h3>

- [Kubernetes Documentation: Admission Controllers](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/)
- [Kubernetes Documentation: Validating Admission Policy](https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/)
