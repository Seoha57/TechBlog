---
layout: post
title: "Argo CD 입문: GitOps로 Git의 선언과 클러스터 상태를 계속 일치시키는 배포 방식"
categories: [Infrastructure]
tags: [infrastructure, argo-cd, gitops, kubernetes, declarative-delivery, drift, sync, rollback]
description: "Argo CD(아르고 씨디)와 GitOps가 무엇이고 왜 등장했는지, Git 저장소를 단일 진실 공급원으로 두고 클러스터 상태를 자동 비교·동기화하는 구조, Application 작성, Sync·Health 상태, selfHeal·prune, sync wave, ApplicationSet, 롤백과 장애 점검 절차를 처음 접하는 독자도 따라 할 수 있게 명령어와 설정 예시로 설명합니다."
---

## 먼저 답하기

### Q. GitOps와 Argo CD는 각각 무엇인가요?

A. GitOps(깃옵스)는 "시스템이 어떤 상태여야 하는지를 Git 저장소에 선언해 두고, 실제 시스템이 그 선언과 같아지도록 자동화 도구가 계속 맞춰 주는 운영 방식"입니다. Argo CD(Argo Continuous Delivery, 아르고 씨디)는 이 방식을 쿠버네티스에서 구현한 오픈소스 도구로, CNCF(Cloud Native Computing Foundation, 클라우드 네이티브 컴퓨팅 재단)에서 졸업(graduated) 단계 프로젝트로 관리됩니다. Argo CD는 Git에 있는 매니페스트(manifest, 쿠버네티스 리소스를 적은 YAML 파일)와 클러스터에 실제로 떠 있는 리소스를 주기적으로 비교하고, 다르면 "OutOfSync(동기화 안 됨)"로 표시하며, 설정에 따라 자동으로 맞춥니다. 이 글은 공식 문서를 바탕으로 정리한 학습 자료이며, 제가 직접 운영하면서 측정한 결과가 아닙니다. 아래 설정은 문서의 필드 이름에 맞춰 작성한 예시이므로, 실제 적용 전에 시험 클러스터에서 먼저 확인하세요.

### Q. 그냥 CI에서 `kubectl apply`를 실행하면 안 되나요?

A. 가능하고 많은 팀이 그렇게 시작합니다. 다만 CI 서버가 클러스터에 접속할 자격 증명을 들고 있어야 하고, 배포는 "파이프라인이 실행된 그 순간"에만 일어납니다. 누군가 `kubectl edit`로 클러스터의 값을 직접 바꿔도 다음 배포 전까지는 아무도 모릅니다. GitOps는 클러스터 안의 도구가 Git을 읽어 가져오는(pull) 방식이라 클러스터 자격 증명을 밖으로 내보내지 않아도 되고, 상태가 어긋나면 계속 감지합니다. 두 방식의 차이는 아래 「기존 방식과 비교」 표와 「Sync 상태와 Health 상태」 절에서 자세히 다룹니다.

### Q. Argo CD는 CI(빌드·테스트)를 대체하나요?

A. 아닙니다. CI(Continuous Integration, 지속적 통합)는 코드를 빌드하고 테스트해 컨테이너 이미지를 만드는 단계이고, Argo CD는 그다음 단계인 "이미지를 어떤 버전으로 클러스터에 올릴지"를 Git에 적힌 대로 반영하는 CD(Continuous Delivery, 지속적 전달) 단계를 맡습니다. 보통 CI가 이미지를 만들고 매니페스트 저장소의 이미지 태그를 바꾸는 커밋을 올리면, Argo CD가 그 커밋을 감지해 배포합니다. 역할 분리는 아래 「업무 예시: 배포 승인과 롤백」 절에서 구체적인 흐름으로 보여 드립니다.

### Q. 항상 Argo CD를 써야 하나요?

A. 아닙니다. 클러스터가 한두 개이고 배포 빈도가 낮으며 사람이 직접 관리해도 충분하다면 도입 비용이 더 클 수 있습니다. 반대로 여러 환경·여러 팀이 같은 방식으로 배포하고, 변경 이력과 승인 근거를 Git에 남겨야 한다면 잘 맞습니다. 선택 기준은 아래 「한계와 적용 기준 Q&A」 절에서 정리합니다.

## 먼저 알아둘 기반 기술

이 절은 본문을 읽는 데 필요한 지식을 가장 밑바닥(선언적 구성)에서부터 Argo CD 직전(배포 방식의 두 갈래)까지 순서대로 쌓습니다. 각 소절 끝에는 그 개념이 본문의 어느 절에서 다시 쓰이는지 적었고, 절 마지막에 전체 연결 지도를 표로 정리했습니다.

### 선언적 구성과 원하는 상태(desired state)

선언적(declarative) 구성은 "어떤 순서로 무엇을 실행할지"가 아니라 "최종적으로 어떤 모습이어야 하는지"를 적는 방식입니다. 반대로 명령형(imperative)은 `kubectl create`, `kubectl scale`처럼 단계별 명령을 내리는 방식입니다. 식당에 비유하면 선언적 방식은 "오늘 테이블 열 개에 의자 네 개씩"이라는 배치도를 걸어 두는 것이고, 명령형은 직원에게 "의자를 하나 가져와 놓고, 또 하나 가져와 놓고…"라고 시키는 것입니다. 배치도가 있으면 누가 의자를 치워도 "배치도와 다르다"는 사실을 바로 알 수 있습니다. 이 "배치도"에 해당하는 것이 원하는 상태(desired state)이고, 지금 실제로 놓인 의자가 현재 상태(live state)입니다.

예를 들어 아래 YAML은 "web이라는 Deployment가 이미지 `web:1.4.2` 컨테이너 3개로 떠 있어야 한다"는 선언입니다. 이 선언을 이해해야 Argo CD가 비교하는 대상이 무엇인지 알 수 있습니다. 이 개념은 아래 「Sync 상태와 Health 상태」 절에서 두 상태의 차이를 계산하는 기준으로, 「자동 동기화, prune, selfHeal」 절에서 "어긋난 것을 되돌린다"는 동작의 의미로 이어집니다.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      containers:
        - name: web
          image: registry.example.com/shop/web:1.4.2
```

### Git: 커밋, 브랜치, 변경 이력

Git은 파일의 변경 이력을 커밋(commit, 어느 시점의 저장본) 단위로 기록하는 분산 버전 관리 도구입니다. 모든 커밋은 고유한 해시(hash, 예: `a1b2c3d`)와 작성자, 시각, 메시지를 갖고, 브랜치(branch)는 커밋 줄기에 붙인 이름표입니다. `git diff`는 두 시점의 차이를 보여 주고, `git revert`는 특정 커밋의 변경을 되돌리는 새 커밋을 만듭니다. 이력이 지워지지 않고 쌓이므로 "누가, 언제, 왜 바꿨는가"가 자연스럽게 남습니다. PR(Pull Request, 풀 리퀘스트) 같은 리뷰 절차를 얹으면 승인 기록도 함께 남습니다.

GitOps가 Git을 단일 진실 공급원(single source of truth)으로 삼는 이유가 여기 있습니다. 클러스터를 직접 만지는 방식에서는 변경 이력이 사람의 기억이나 별도 문서에 흩어지지만, Git에 선언을 두면 배포 이력이 곧 커밋 이력이 됩니다. 롤백도 "이전 커밋 상태로 되돌린다"는 익숙한 동작이 됩니다. 이 개념은 아래 「Argo CD 구성 요소와 동작 구조」 절에서 저장소 서버가 커밋 해시를 기준으로 렌더링하는 부분으로, 「업무 예시: 배포 승인과 롤백」 절에서 `git revert` 기반 롤백으로 이어집니다.

### 쿠버네티스의 조정 루프(reconciliation loop)

쿠버네티스는 선언적 시스템입니다. API Server에 "Deployment replicas는 3"이라는 object를 저장하면, 컨트롤러(controller)가 현재 Pod 수를 계속 관찰하다가 2개뿐이면 하나를 더 만듭니다. 이처럼 "관찰 → 비교 → 조치"를 끝없이 반복해 현재 상태를 원하는 상태에 가깝게 만드는 구조를 조정 루프(reconciliation loop) 또는 컨트롤 루프라고 부릅니다. 에어컨의 희망 온도 설정과 같습니다. 실내 온도가 높으면 냉방하고, 낮아지면 멈추는 일을 사람이 지시하지 않아도 반복합니다.

중요한 점은 쿠버네티스 컨트롤러가 맞추는 대상이 "API Server에 저장된 object"이지 "Git 저장소의 파일"이 아니라는 것입니다. 즉 쿠버네티스의 조정 루프는 Git을 모릅니다. Argo CD는 이 루프를 한 단계 바깥으로 확장해 "Git의 선언 → API Server의 object"를 맞추는 상위 컨트롤러로 이해하면 쉽습니다. 이 개념은 아래 「Argo CD 구성 요소와 동작 구조」 절의 application-controller 설명으로, 「Sync 상태와 Health 상태」 절에서 Argo CD가 보는 두 종류의 상태를 구분하는 근거로 이어집니다.

### 매니페스트 렌더링: 일반 YAML, Helm, Kustomize

실제 서비스에서는 환경(개발·스테이징·운영)마다 replicas, 이미지 태그, 도메인 같은 값이 조금씩 다릅니다. 이 차이를 관리하는 도구가 Helm과 Kustomize입니다. Helm(헬름)은 템플릿에 값 파일(`values.yaml`)을 끼워 YAML을 만들어 주는 패키지 관리자이고, Kustomize(커스터마이즈)는 공통 기본(base) YAML 위에 환경별 패치(overlay)를 덧씌워 최종 YAML을 만드는 도구입니다. 둘 다 "입력 파일을 받아 최종 매니페스트를 출력"하는 렌더링(rendering) 단계라는 점이 같습니다. 직접 확인하려면 `helm template` 또는 `kubectl kustomize` 명령으로 결과를 미리 볼 수 있습니다.

Argo CD는 Git에 있는 원본(차트·kustomization·일반 YAML)을 스스로 렌더링해서 그 결과를 클러스터와 비교합니다. 그래서 "Git에 적힌 파일"과 "비교에 쓰이는 최종 매니페스트"가 다를 수 있다는 점을 알아야 diff 결과를 해석할 수 있습니다. 이 개념은 아래 「Argo CD 구성 요소와 동작 구조」 절의 repo-server 역할로, 「ApplicationSet으로 여러 환경 만들기」 절에서 환경별 경로·값 파일 분리로 이어집니다.

```bash
helm template web ./charts/web -f values-prod.yaml | head -20
kubectl kustomize overlays/prod | head -20
```

### 배포의 두 갈래: push 방식과 pull 방식

푸시(push) 방식은 외부 시스템(예: CI 서버)이 클러스터에 접속해 변경을 밀어 넣는 방식이고, 풀(pull) 방식은 클러스터 안의 에이전트가 저장소를 읽어 와서 스스로 반영하는 방식입니다. 우편에 비유하면 푸시는 집배원이 각 집 열쇠를 들고 다니며 직접 문 안에 넣는 것이고, 풀은 각 집이 우체국 사서함을 정기적으로 확인하러 가는 것입니다. 푸시 방식은 외부에 클러스터 자격 증명(kubeconfig, 서비스 계정 토큰)이 있어야 하고, 풀 방식은 클러스터가 저장소 읽기 권한만 있으면 됩니다.

Argo CD는 풀 방식이며, 이 차이가 보안 경계와 드리프트 감지 능력을 결정합니다. 이 개념은 아래 「기존 방식과 비교」 표에서 두 방식을 한눈에 비교하는 데, 「한계와 적용 기준 Q&A」 절에서 "Argo CD 자체가 고권한 계정을 갖는 위험"을 이야기하는 데 쓰입니다.

### 기존 방식과 비교

| 구분 | 수동 `kubectl apply` | CI 파이프라인 push 배포 | GitOps pull 배포(Argo CD) |
|---|---|---|---|
| 배포 시점 | 사람이 명령을 칠 때 | 파이프라인 실행 순간 | Git 변경 감지 시 또는 주기적 |
| 클러스터 자격 증명 | 담당자 PC | CI 서버가 보관 | 클러스터 내부 컨트롤러가 보유 |
| 직접 수정(드리프트) 감지 | 없음 | 다음 배포 전까지 없음 | 지속 비교, 자동 복구 선택 가능 |
| 변경 이력 | 개인 기록·셸 히스토리 | 파이프라인 로그 | Git 커밋·PR 이력 |
| 롤백 | 이전 파일을 찾아 다시 적용 | 이전 파이프라인 재실행 | `git revert` 또는 이전 리비전 동기화 |
| 여러 클러스터 | 클러스터마다 반복 | 파이프라인 설정 복잡 | 한 Argo CD가 여러 클러스터를 등록해 관리 가능 |

### 기반 개념과 본문 연결 지도

| 기반 개념 | 쓰이는 본문 절 | 그 절에서의 역할 |
|---|---|---|
| 선언적 구성과 desired state | Sync 상태와 Health 상태 | Git의 선언과 live state의 차이 계산 |
| 선언적 구성과 desired state | 자동 동기화, prune, selfHeal | 어긋난 리소스를 되돌리는 동작의 기준 |
| Git 커밋·브랜치·이력 | Argo CD 구성 요소와 동작 구조 | 커밋 해시 기준 렌더링과 캐시 |
| Git 커밋·브랜치·이력 | 업무 예시: 배포 승인과 롤백 | PR 승인과 `git revert` 롤백 |
| 쿠버네티스 조정 루프 | Argo CD 구성 요소와 동작 구조 | application-controller를 상위 루프로 이해 |
| 쿠버네티스 조정 루프 | Sync 상태와 Health 상태 | Sync 상태와 Health 상태의 구분 |
| 매니페스트 렌더링 | Argo CD 구성 요소와 동작 구조 | repo-server의 렌더링 역할 |
| 매니페스트 렌더링 | ApplicationSet으로 여러 환경 만들기 | 환경별 경로·values 분리 |
| push·pull 배포 | 한계와 적용 기준 Q&A | 고권한 계정 위험과 보안 경계 |
| push·pull 배포 | 실습 예시: Application 만들고 동기화하기 | 클러스터 내부에서 저장소를 읽는 구조 확인 |

## Argo CD 구성 요소와 동작 구조

앞서 기반 기술에서 본 조정 루프를 Argo CD가 어떻게 한 단계 바깥에서 돌리는지 구성 요소별로 살펴봅니다. Argo CD는 쿠버네티스 안에 `argocd` 네임스페이스로 설치되는 여러 컴포넌트의 모음입니다. 핵심은 다섯 가지입니다.

첫째, API Server(`argocd-server`)는 웹 UI, CLI(`argocd`), 외부 연동이 접속하는 창구입니다. 인증과 권한(RBAC) 검사도 여기서 이뤄집니다. 둘째, Repository Server(`argocd-repo-server`)는 Git 저장소를 복제(clone)해 두고, 지정된 경로의 YAML·Helm 차트·Kustomize를 렌더링해 최종 매니페스트를 만들어 주는 내부 서비스입니다. 셋째, Application Controller(`argocd-application-controller`)는 실제 조정 루프를 담당합니다. 렌더링된 원하는 상태와 클러스터의 live state를 비교하고, 동기화가 필요하면 쿠버네티스 API를 호출해 반영합니다. 넷째, Redis는 비교 결과와 캐시를 저장하는 보조 저장소입니다. 다섯째, Dex 같은 선택적 인증 연동 컴포넌트는 SSO(Single Sign-On, 통합 인증)를 붙일 때 쓰입니다.

<figure class="article-figure"><img src="{{ '/assets/images/argo-cd-gitops-reconcile-flow.svg' | relative_url }}" alt="Git 저장소의 매니페스트를 repo-server가 렌더링하고, application-controller가 클러스터의 live state와 비교해 Synced 또는 OutOfSync로 판정하고 동기화하는 Argo CD 동작 흐름"><figcaption>Argo CD의 비교·동기화 흐름. 이미지 출처: 직접 제작</figcaption></figure>

동작 순서를 말로 풀면 이렇습니다. ① 개발자가 매니페스트 저장소에 변경을 커밋합니다. ② repo-server가 저장소의 특정 리비전(revision, 커밋 해시 또는 브랜치·태그)을 가져와 렌더링합니다. ③ application-controller가 렌더링 결과와 클러스터의 live state를 비교합니다. ④ 차이가 있으면 해당 Application을 OutOfSync로 표시합니다. ⑤ 자동 동기화가 켜져 있으면 controller가 쿠버네티스 API에 변경을 적용하고, 꺼져 있으면 사람이 UI나 CLI에서 Sync를 누를 때까지 기다립니다. ⑥ 적용 후에는 리소스가 실제로 정상 동작하는지 Health 상태를 계속 평가합니다.

Git 변경을 감지하는 방법은 두 가지입니다. 기본값은 약 3분 간격의 폴링(polling, 주기적 확인)이고, GitHub·GitLab 등의 Webhook(웹훅, 변경 시 호출되는 알림)을 Argo CD API Server에 연결하면 거의 즉시 반응합니다. 공식 문서는 폴링 간격이 `timeout.reconciliation` 설정으로 조정된다고 설명합니다. 그래서 "커밋했는데 왜 바로 배포되지 않나요?"라는 질문의 첫 확인 사항은 웹훅 연결 여부입니다.

## Application 리소스 작성

Argo CD가 관리하는 배포 단위는 Application이라는 CRD(Custom Resource Definition, 쿠버네티스에 새 종류의 리소스를 추가하는 확장)입니다. Application 하나는 "어느 저장소의 어느 경로를, 어느 클러스터의 어느 네임스페이스에 배포하는가"를 선언합니다. 즉 Argo CD 자신의 설정도 선언적 YAML로 Git에 둘 수 있습니다.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: shop-web-prod
  namespace: argocd
spec:
  project: shop
  source:
    repoURL: https://git.example.com/platform/shop-manifests.git
    targetRevision: main
    path: apps/web/overlays/prod
  destination:
    server: https://kubernetes.default.svc
    namespace: shop-prod
  syncPolicy:
    syncOptions:
      - CreateNamespace=true
```

각 필드의 의미는 다음과 같습니다. `project`는 뒤에서 다룰 AppProject 이름으로, 허용된 저장소·대상 클러스터·네임스페이스의 경계를 정합니다. `source.repoURL`은 매니페스트 저장소 주소이고, `targetRevision`은 추적할 브랜치·태그·커밋입니다. 운영 환경에서는 `main` 대신 태그나 커밋 해시로 고정하는 방법도 있는데, 장단점은 아래 「한계와 적용 기준 Q&A」에서 다룹니다. `path`는 저장소 안의 디렉터리이며, 그 안에 `kustomization.yaml`이나 `Chart.yaml`이 있으면 Argo CD가 자동으로 종류를 판별해 렌더링합니다. `destination.server`가 `https://kubernetes.default.svc`이면 Argo CD가 설치된 클러스터 자신을 뜻합니다.

저장소 구조는 보통 앱 코드 저장소와 매니페스트 저장소를 분리합니다. 코드 저장소는 빌드·테스트가 자주 일어나고 커밋이 잦지만, 매니페스트 저장소는 "무엇이 배포되는가"의 기록이어야 하므로 변경이 의도적이고 리뷰된 것만 들어가야 합니다. 분리하면 CI가 이미지 빌드마다 코드 저장소에 쌓는 커밋과 배포 승인 이력이 섞이지 않습니다.

```text
shop-manifests/
├── apps/
│   └── web/
│       ├── base/
│       │   ├── deployment.yaml
│       │   ├── service.yaml
│       │   └── kustomization.yaml
│       └── overlays/
│           ├── dev/kustomization.yaml
│           ├── stg/kustomization.yaml
│           └── prod/kustomization.yaml
└── argocd/
    └── applications/
        └── shop-web-prod.yaml
```

## Sync 상태와 Health 상태

Argo CD UI에서 가장 먼저 보이는 두 단어가 Sync 상태와 Health 상태입니다. 둘은 서로 다른 질문에 답하므로 구분해서 읽어야 합니다. 앞서 기반 기술에서 본 선언적 구성의 두 상태, 즉 desired state와 live state의 비교 결과가 Sync 상태이고, 쿠버네티스 조정 루프가 만들어 낸 live state가 실제로 건강한지가 Health 상태입니다.

| 구분 | 질문 | 값 | 의미 |
|---|---|---|---|
| Sync 상태 | Git의 선언과 클러스터가 같은가 | Synced | 렌더링 결과와 live state가 일치 |
| Sync 상태 | 위와 같음 | OutOfSync | 둘이 다름(Git 변경 또는 직접 수정) |
| Health 상태 | 리소스가 정상 동작하는가 | Healthy | Deployment가 모든 replica를 준비 완료 |
| Health 상태 | 위와 같음 | Progressing | 롤링 업데이트 등 아직 진행 중 |
| Health 상태 | 위와 같음 | Degraded | 실패(Pod CrashLoopBackOff, 이미지 풀 실패 등) |
| Health 상태 | 위와 같음 | Missing / Unknown | 리소스가 없거나 판정 불가 |

두 상태는 독립적입니다. "Synced이지만 Degraded"는 Git대로 잘 적용했지만 앱 자체가 죽어 있다는 뜻입니다. 예를 들어 이미지 태그를 잘못 적어 Git에 커밋하면 Argo CD는 그대로 반영해 Synced가 되지만, Pod는 `ImagePullBackOff`로 Degraded가 됩니다. 반대로 "OutOfSync이지만 Healthy"는 누군가 `kubectl scale`로 replicas를 5로 바꿔 서비스는 잘 돌지만 Git(3)과 달라진 상황입니다. 이 구분을 모르고 "초록색이니 괜찮다"고 판단하면 드리프트를 놓칩니다.

Argo CD가 diff를 계산할 때는 쿠버네티스가 자동으로 채우는 필드(status, resourceVersion, 기본값)를 제외하고 비교합니다. 그래도 컨트롤러가 값을 계속 바꾸는 필드(예: HPA가 조정하는 `spec.replicas`)는 영구 OutOfSync를 만들 수 있어서, 이런 필드는 `ignoreDifferences`로 비교에서 제외합니다.

```yaml
spec:
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas
```

## 자동 동기화, prune, selfHeal

Argo CD의 동기화(sync)는 기본적으로 수동입니다. OutOfSync가 표시되어도 사람이 Sync 버튼을 눌러야 반영됩니다. 자동화하려면 `syncPolicy.automated`를 켭니다. 이때 자주 함께 쓰는 옵션이 `prune`과 `selfHeal`이고, 둘의 차이가 중요합니다.

```yaml
syncPolicy:
  automated:
    prune: true
    selfHeal: true
  syncOptions:
    - CreateNamespace=true
    - PruneLast=true
  retry:
    limit: 5
    backoff:
      duration: 10s
      factor: 2
      maxDuration: 3m
```

`prune`은 "Git에서 지워진 리소스를 클러스터에서도 삭제할지"를 정합니다. 꺼져 있으면 Git에서 YAML 파일을 지워도 클러스터에는 그 리소스가 남아 고아(orphan)가 됩니다. `selfHeal`은 "클러스터에서 누군가 직접 바꾼 값을 Git 상태로 되돌릴지"를 정합니다. 꺼져 있으면 Git에 새 커밋이 있을 때만 동기화가 일어나고, 직접 수정은 OutOfSync로 표시만 될 뿐 방치됩니다. `retry`는 일시적 실패 때 재시도 방식을 정합니다. `PruneLast=true`는 삭제를 마지막 단계로 미뤄, 새 리소스가 정상 적용된 뒤에 옛 리소스를 정리하게 합니다.

| 옵션 | 켜면 | 위험 | 권장 상황 |
|---|---|---|---|
| `automated` 단독 | Git 변경만 자동 반영 | 직접 수정은 방치 | 도입 초기, 드리프트 현황 관찰 |
| `prune: true` | Git에서 삭제하면 클러스터에서도 삭제 | 실수로 파일을 지우면 리소스 삭제(PVC 포함 가능) | 리뷰 절차가 확실한 환경 |
| `selfHeal: true` | 직접 수정을 즉시 되돌림 | 긴급 수동 조치가 덮어써짐 | 변경 통제가 확립된 운영 환경 |

현실적인 도입 순서는 이렇습니다. 처음에는 수동 동기화로 시작해 Argo CD의 diff가 기대와 맞는지 며칠 관찰합니다. 다음으로 `automated`만 켜서 Git 변경을 자동 반영하되, 삭제와 복구는 사람이 판단합니다. 마지막으로 변경 통제 절차(PR 승인, 긴급 변경 절차)가 자리 잡힌 뒤에 `prune`과 `selfHeal`을 켭니다. 특히 `selfHeal`을 켜면 장애 중에 `kubectl`로 급히 바꾼 설정이 몇 분 뒤 Git 값으로 되돌아가므로, 긴급 변경도 "Git에 먼저 커밋"이 원칙이 된다는 점을 팀이 합의해야 합니다.

데이터가 담긴 리소스는 `prune`에서 특히 조심해야 합니다. PVC(PersistentVolumeClaim, 저장소 요청)나 StatefulSet이 Git에서 실수로 빠지면 삭제될 수 있으므로, 중요 리소스에는 annotation `argocd.argoproj.io/sync-options: Prune=false`를 붙여 prune 대상에서 제외할 수 있습니다.

```yaml
metadata:
  annotations:
    argocd.argoproj.io/sync-options: Prune=false
```

## 실습 예시: Application 만들고 동기화하기

아래는 시험 클러스터에서 Argo CD를 설치하고 Application 하나를 만들어 동기화하는 흐름입니다. 공식 문서의 Getting Started 절차를 요약한 것이며, 이 글에서 제가 직접 실행한 결과를 옮긴 것이 아니므로 출력은 형식 예시입니다. 실제 환경에서는 설치 매니페스트의 버전을 고정(pin)해서 쓰세요. 기반 기술에서 본 pull 방식 그대로, 클러스터 안에서 저장소를 읽어 가는 구조라는 점을 확인할 수 있습니다.

```bash
kubectl create namespace argocd
kubectl apply -n argocd --server-side -f \
  https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl -n argocd get pods
```

초기 admin 비밀번호는 Secret에 저장됩니다. 로그인 후에는 반드시 비밀번호를 바꾸고 초기 Secret을 삭제하는 것이 공식 문서의 안내입니다. 로컬 확인에는 포트 포워딩을 씁니다.

```bash
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d; echo
kubectl -n argocd port-forward svc/argocd-server 8080:443 &
argocd login localhost:8080 --username admin --insecure
```

이제 CLI로 Application을 만들고 상태를 봅니다. 위에서 본 YAML을 `kubectl apply`로 올려도 결과는 같습니다.

```bash
argocd app create guestbook \
  --repo https://github.com/argoproj/argocd-example-apps.git \
  --path guestbook \
  --dest-server https://kubernetes.default.svc \
  --dest-namespace default

argocd app get guestbook
# Name:               argocd/guestbook
# Sync Status:        OutOfSync from  (53e28ff)
# Health Status:      Missing
argocd app diff guestbook
argocd app sync guestbook
argocd app wait guestbook --health --timeout 120
```

처음에는 리소스가 클러스터에 없으므로 `OutOfSync / Missing`이고, `sync` 후에는 `Synced / Healthy`가 되는 것이 정상 흐름입니다. 이때 클러스터에서 직접 replicas를 바꿔 드리프트를 만들어 보면 Argo CD가 무엇을 감지하는지 확인할 수 있습니다.

```bash
kubectl -n default scale deploy/guestbook-ui --replicas=4
argocd app get guestbook        # Sync Status: OutOfSync
argocd app diff guestbook       # spec.replicas 1 -> 4 차이 표시
argocd app sync guestbook       # Git 값(1)으로 되돌림
```

## sync wave와 hook으로 적용 순서 제어하기

여러 리소스를 한 번에 적용할 때는 순서가 중요합니다. 데이터베이스 스키마를 바꾸는 Job이 끝난 뒤에 애플리케이션을 새 버전으로 올려야 하고, Namespace와 ConfigMap이 먼저 있어야 Deployment가 뜹니다. Argo CD는 기본적으로 리소스 종류별 내장 순서로 적용하지만, 세밀한 순서는 sync wave(싱크 웨이브)와 resource hook(리소스 훅)으로 지정합니다.

sync wave는 리소스에 정수 번호를 붙이는 방식입니다. annotation `argocd.argoproj.io/sync-wave`의 값이 작은 wave부터 적용하고, 한 wave의 리소스가 Healthy가 된 뒤에야 다음 wave로 넘어갑니다. 기본값은 0이고 음수도 쓸 수 있습니다.

```yaml
# wave -1: 설정을 먼저
apiVersion: v1
kind: ConfigMap
metadata:
  name: web-config
  annotations:
    argocd.argoproj.io/sync-wave: "-1"
---
# wave 0: 기본, 앱 본체
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  annotations:
    argocd.argoproj.io/sync-wave: "0"
```

hook은 동기화 단계의 특정 시점에 Job 같은 리소스를 실행하는 장치입니다. `PreSync`는 본 적용 전에, `Sync`는 적용 중에, `PostSync`는 모든 리소스가 Healthy가 된 뒤에, `SyncFail`은 동기화가 실패했을 때 실행됩니다. 아래는 배포 전에 데이터베이스 마이그레이션을 실행하는 예시입니다. `hook-delete-policy`를 지정하지 않으면 Job이 남아 다음 동기화 때 이름이 충돌할 수 있으므로 성공 시 삭제하도록 합니다.

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migrate
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: registry.example.com/shop/migrate:1.4.2
          args: ["--target", "latest"]
```

PreSync hook이 실패하면 본 적용은 진행되지 않습니다. 이것은 장점이지만, 마이그레이션이 되돌릴 수 없는 변경이라면 "스키마는 바뀌었는데 앱은 옛 버전"인 상태가 생길 수 있습니다. 그래서 DBA와 협의해 앞뒤 버전이 모두 동작하는 호환 가능한 마이그레이션(확장 후 축소 방식)으로 설계하는 것이 안전합니다. hook은 순서 제어 수단일 뿐 데이터 변경의 롤백까지 보장하지 않습니다.

## ApplicationSet으로 여러 환경 만들기

환경이 dev, stg, prod 셋이고 서비스가 열 개라면 Application이 서른 개입니다. 이를 손으로 복사하면 필드 하나를 바꿀 때마다 서른 군데를 고쳐야 합니다. ApplicationSet은 템플릿 하나와 "생성기(generator)"로 Application 여러 개를 자동 생성하는 리소스입니다. 아래 예시는 List 생성기로 환경 세 개를 만듭니다. 이 YAML의 이중 중괄호는 ApplicationSet이 치환하는 문법이며, 블로그 빌드(Jekyll)가 해석하지 않도록 Liquid raw 구간 안에 넣었습니다.

{% raw %}
```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: shop-web
  namespace: argocd
spec:
  generators:
    - list:
        elements:
          - env: dev
            cluster: https://kubernetes.default.svc
          - env: stg
            cluster: https://kubernetes.default.svc
          - env: prod
            cluster: https://prod.example.com:6443
  template:
    metadata:
      name: 'shop-web-{{env}}'
    spec:
      project: shop
      source:
        repoURL: https://git.example.com/platform/shop-manifests.git
        targetRevision: main
        path: 'apps/web/overlays/{{env}}'
      destination:
        server: '{{cluster}}'
        namespace: 'shop-{{env}}'
```
{% endraw %}

생성기는 List 외에도 Git 디렉터리 구조를 읽는 Git 생성기, Argo CD에 등록된 클러스터 목록을 읽는 Cluster 생성기 등이 있습니다. Git 디렉터리 생성기를 쓰면 `apps/*/overlays/*` 폴더를 새로 만들기만 해도 Application이 자동으로 생기므로, 새 서비스 온보딩이 "폴더 추가 PR" 하나로 끝납니다. 기반 기술에서 본 Kustomize overlay 구조와 잘 맞는 이유입니다.

다만 ApplicationSet의 강력함은 위험이기도 합니다. 생성기 조건이 잘못되면 의도하지 않은 Application이 대량 생성되거나 삭제될 수 있습니다. 공식 문서는 ApplicationSet 컨트롤러의 삭제 정책을 제한하는 옵션(`preserveResourcesOnDeletion` 등)을 제공하므로, 운영 환경에서는 Application 삭제가 하위 리소스 삭제로 번지지 않도록 확인해야 합니다.

## AppProject와 권한 경계

Application을 만들 수 있다는 것은 곧 "이 클러스터의 이 네임스페이스에 무엇이든 배포할 수 있다"는 뜻이 될 수 있습니다. 이를 제한하는 장치가 AppProject입니다. AppProject는 허용할 소스 저장소, 배포 대상 클러스터·네임스페이스, 생성 가능한 리소스 종류를 정해 Application의 활동 범위를 가둡니다. 팀이 여럿이면 팀마다 프로젝트를 나눠 서로의 네임스페이스에 배포하지 못하게 합니다.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: shop
  namespace: argocd
spec:
  description: shop team applications
  sourceRepos:
    - https://git.example.com/platform/shop-manifests.git
  destinations:
    - server: https://kubernetes.default.svc
      namespace: shop-*
  clusterResourceWhitelist: []
  namespaceResourceBlacklist:
    - group: ''
      kind: ResourceQuota
  roles:
    - name: deployer
      description: sync only
      policies:
        - p, proj:shop:deployer, applications, sync, shop/*, allow
      groups:
        - shop-deployers
```

위 설정에서 `clusterResourceWhitelist`가 비어 있으면 ClusterRole·Namespace 같은 클러스터 범위 리소스는 이 프로젝트에서 만들 수 없습니다. `roles`는 프로젝트 안에서 "sync만 가능"한 역할을 정의하며, SSO 그룹과 연결할 수 있습니다. 이 구조 덕분에 개발자에게는 "동기화 버튼"만 주고 "프로젝트 설정 변경"은 플랫폼 팀이 갖는 식의 권한 분리가 가능해집니다. 전체 RBAC는 `argocd-rbac-cm` ConfigMap에서 정의합니다.

## 시크릿을 Git에 어떻게 두는가

GitOps의 가장 흔한 질문은 "비밀번호와 API 키는 어디에 두나요?"입니다. 평문 Secret을 Git에 올리면 저장소를 읽을 수 있는 모든 사람이 값을 알게 되고, 이력에서 지워도 과거 커밋에 남습니다. 해결 방식은 크게 두 가지입니다. 첫째는 암호화한 Secret을 Git에 두는 방식으로, Sealed Secrets나 SOPS(Secrets OPerationS)가 대표적입니다. 둘째는 Git에는 "어디에서 가져올지"만 적고 실제 값은 외부 비밀 저장소(Vault, 클라우드의 Secret Manager)에 두는 방식으로, External Secrets Operator 같은 도구가 클러스터 안에서 값을 가져와 Secret을 만듭니다.

Argo CD 자체는 시크릿을 관리하는 도구가 아니므로 어느 방식을 쓸지는 조직의 정책에 달려 있습니다. 한 가지 확인할 점은 Argo CD가 비교하는 대상에 Secret이 포함되므로, UI에서 Secret 값이 노출되지 않게 RBAC로 `get` 권한을 제한하는 것입니다. 시크릿 회전은 앞서 다른 글에서 다룬 Secret 회전 절차와 이어서 설계하는 것이 좋습니다.

## 업무 예시: 배포 승인과 롤백

가상의 "쇼핑몰 웹 서비스" 팀이 Argo CD로 배포하는 흐름을 가정해 봅니다. 이 예시는 설명을 위한 가상 시나리오이며 실제 운영 사례가 아닙니다.

첫째, 개발자가 앱 코드 저장소에 변경을 병합합니다. CI가 이미지를 `web:1.4.3`으로 빌드·스캔·푸시합니다. 둘째, CI의 마지막 단계가 매니페스트 저장소에 "dev 환경 이미지 태그를 1.4.3으로" 바꾸는 커밋을 올립니다(예: `kustomize edit set image`). dev는 자동 동기화가 켜져 있으므로 곧 반영됩니다. 셋째, 검증이 끝나면 prod 환경 overlay의 이미지 태그를 바꾸는 PR을 만들고, 승인자가 리뷰해 병합합니다. 이 PR이 곧 배포 승인 기록입니다. 넷째, prod Application은 자동 동기화이지만 변경 시간을 제한하고 싶다면 `syncWindows`(동기화 허용 시간대)를 AppProject에 설정할 수 있습니다.

```bash
# CI의 마지막 단계 예시: 매니페스트 저장소의 dev 이미지 태그 갱신
git clone https://git.example.com/platform/shop-manifests.git
cd shop-manifests/apps/web/overlays/dev
kustomize edit set image registry.example.com/shop/web=registry.example.com/shop/web:1.4.3
git commit -am "chore(dev): web 1.4.3 배포"
git push origin main
```

배포 후 장애가 발생했다고 합시다. 롤백 방법은 두 가지입니다. 권장되는 방법은 Git에서 해당 커밋을 `git revert`하는 것입니다. 되돌림 자체가 커밋으로 남고, 자동 동기화가 켜져 있으면 Argo CD가 곧 이전 상태로 되돌립니다. 두 번째는 Argo CD의 `app rollback` 명령으로 이전에 성공했던 리비전을 즉시 배포하는 것인데, 이 명령은 자동 동기화가 켜져 있으면 사용할 수 없고(자동 동기화가 다시 Git 최신 상태로 맞추기 때문), 또 Git과 클러스터가 어긋난 상태가 되므로 임시 조치로만 쓰고 이후 Git을 반드시 맞춰야 합니다.

```bash
# 권장: Git에서 되돌리기
git revert 9f3c2ab
git push origin main
argocd app wait shop-web-prod --sync --health --timeout 300

# 임시 조치: 이전 리비전 즉시 배포(자동 동기화 비활성 시)
argocd app history shop-web-prod
argocd app rollback shop-web-prod 12
```

이 흐름의 장점은 "누가 언제 무엇을 승인했고 무엇으로 되돌렸는가"가 모두 Git 이력에 남는다는 점입니다. 감사(audit) 대응이나 변경 관리 절차(ITSM의 변경 승인)와도 연결하기 쉽습니다. 단점은 Git 저장소가 곧 배포의 관문이라, 저장소 장애나 병합 권한 관리 실수가 배포 전체에 영향을 준다는 점입니다.

## 문제 점검 절차

Argo CD에서 문제가 생기면 "어느 단계에서 막혔는가"를 나누어 보면 빨리 좁혀집니다. 저장소 읽기, 렌더링, 비교, 적용, 상태 평가 순서입니다.

| 증상 | 가능한 원인 | 먼저 볼 것 |
|---|---|---|
| Application이 `Unknown`/`ComparisonError` | 저장소 접근 실패, 경로 오류, 렌더링 오류 | `argocd app get`의 Conditions, repo-server 로그 |
| 커밋했는데 반영이 늦음 | 기본 폴링 주기 대기, 웹훅 미설정 | 웹훅 연결, `argocd app get --refresh` |
| 계속 OutOfSync 반복 | 다른 컨트롤러(HPA·webhook)가 필드를 계속 변경 | `argocd app diff`, `ignoreDifferences` 설정 |
| Sync 실패 `permission denied` | AppProject 제한, 대상 네임스페이스 미허용 | AppProject의 destinations·whitelist |
| Synced인데 Degraded | 이미지 오류, 프로브 실패, 리소스 부족 | `kubectl describe pod`, `kubectl logs` |
| 삭제했는데 리소스가 남음 | `prune` 꺼짐 또는 `Prune=false` annotation | syncPolicy와 annotation |
| 동기화가 Progressing에서 멈춤 | hook Job 미완료, 헬스 평가 대기 | 해당 hook의 Job·Pod 상태 |

```bash
argocd app get shop-web-prod --refresh            # 저장소를 다시 읽고 비교
argocd app get shop-web-prod -o yaml | grep -A5 conditions
kubectl -n argocd logs deploy/argocd-repo-server --tail=50
kubectl -n argocd logs statefulset/argocd-application-controller --tail=50
argocd app resources shop-web-prod                # 관리 중인 리소스 목록과 상태
```

가장 흔한 실수는 Argo CD를 의심하기 전에 Git 쪽을 확인하지 않는 것입니다. 렌더링 결과가 의도와 다른 경우가 많으므로, 로컬에서 `kubectl kustomize`나 `helm template`로 같은 입력을 렌더링해 보고 Argo CD가 보여 주는 diff와 비교하면 원인이 어느 쪽인지 빠르게 갈립니다.

## 한계와 적용 기준 Q&A

### Q. Argo CD 자체가 단일 장애 지점(SPOF, Single Point of Failure)이 되지 않나요?

A. Argo CD가 멈춰도 이미 떠 있는 애플리케이션은 계속 동작합니다. 다만 그동안 새 배포와 드리프트 복구가 되지 않습니다. 즉 "서비스의 데이터 경로"에는 들어 있지 않지만 "변경 경로"에는 들어 있습니다. 공식 문서는 고가용성(HA) 설치 매니페스트를 제공하며, 운영 환경에서는 이를 사용하고 Argo CD 설정과 Application 정의도 Git에 두어 장애 시 재구축할 수 있게 하는 것이 좋습니다.

### Q. Argo CD는 안전한가요? 클러스터 관리자 권한을 가지지 않나요?

A. 기본 설치의 controller는 넓은 권한을 가집니다. 그래서 Argo CD 자체가 공격 대상이 되면 영향이 큽니다. 완화 방법은 AppProject로 배포 범위를 제한하고, API Server 접근에 SSO와 RBAC를 적용하고, admin 계정을 비활성화하고, 외부에 노출한다면 TLS와 접근 제어를 두는 것입니다. 다른 클러스터를 등록할 때는 최소 권한 서비스 계정을 쓰는 방법도 있습니다. 이 위험은 push 방식에서 CI가 자격 증명을 들고 있는 위험과 성격이 다르지만 사라지는 것이 아니므로, 도입 전에 보안 팀과 구성을 검토해야 합니다.

### Q. `targetRevision`을 `main`으로 둘까요, 태그로 고정할까요?

A. 개발 환경은 `main` 추적이 편리합니다. 운영 환경은 선택이 갈립니다. `main`을 추적하면 병합이 곧 배포이므로 PR 승인이 배포 승인이 되는 단순한 구조가 되지만, 보호 브랜치와 필수 리뷰 설정이 약하면 위험합니다. 태그나 커밋 해시로 고정하면 "어느 버전이 배포되는가"가 명시적이지만, 배포마다 Application의 `targetRevision`을 바꾸는 별도 작업이 필요합니다. 어느 쪽이든 매니페스트 저장소의 브랜치 보호와 리뷰 필수 설정이 선행 조건입니다.

### Q. 모든 리소스를 Argo CD로만 관리해야 하나요?

A. 그렇지 않습니다. HPA처럼 다른 컨트롤러가 조정하는 필드, 운영자가 의도적으로 수동 조치하는 리소스, 데이터가 담긴 상태 저장 리소스는 `ignoreDifferences`나 `Prune=false`로 경계를 정하는 것이 현실적입니다. 또 클러스터 부트스트랩(Argo CD 자신, CNI 등)은 "app of apps" 패턴이나 별도 절차로 나눠 관리하기도 합니다. 처음부터 전부 옮기기보다 영향이 적은 서비스 하나로 시작해 운영 규칙을 만든 뒤 넓히는 것이 안전합니다.

### Q. Flux 같은 다른 GitOps 도구와는 어떻게 고르나요?

A. 둘 다 CNCF 졸업 프로젝트이며 pull 방식의 GitOps라는 원리는 같습니다. 일반적으로 Argo CD는 웹 UI와 Application 단위의 가시성이 강하고, Flux는 쿠버네티스 CRD 중심의 가벼운 구성과 컨트롤러 조합이 특징으로 설명됩니다. 팀이 UI로 상태를 보고 동기화하는 흐름을 원하는지, 전부 CLI·Git 중심으로 운영하는지에 따라 선호가 갈리므로 시험 환경에서 두 도구를 비교해 보는 것이 가장 정확합니다. 이 글은 두 도구의 성능을 직접 비교한 결과를 담고 있지 않습니다.

### Q. 도입 전 체크리스트가 있나요?

A. 다음 항목을 점검해 보세요.

- 매니페스트 저장소에 브랜치 보호와 필수 리뷰가 설정되어 있는가
- 앱 코드 저장소와 매니페스트 저장소의 역할이 분리되어 있는가
- 환경별 차이를 Kustomize overlay 또는 Helm values로 관리하는가
- 처음에는 수동 동기화로 diff를 관찰하고, `prune`·`selfHeal`은 변경 통제 합의 뒤에 켜는가
- 데이터 리소스(PVC·StatefulSet)에 `Prune=false` 등 보호 장치가 있는가
- AppProject로 팀별 배포 범위를 제한하고 admin 계정을 비활성화했는가
- 시크릿 관리 방식(암호화 저장 또는 외부 비밀 저장소)이 정해져 있는가
- Argo CD HA 구성과 자체 설정의 Git 백업이 준비되어 있는가
- 웹훅 연결로 반영 지연을 줄였는가
- 롤백 절차(`git revert` 우선)를 팀이 합의하고 연습했는가

## 마무리

Argo CD와 GitOps의 핵심은 "원하는 상태는 Git에 선언하고, 클러스터 안의 컨트롤러가 그 선언과 현재 상태를 계속 비교해 맞춘다"는 한 문장입니다. 이 구조 덕분에 배포 이력은 커밋 이력이 되고, 롤백은 되돌림 커밋이 되며, 직접 수정된 드리프트는 눈에 보이게 됩니다. 처음에는 수동 동기화로 diff를 읽는 연습부터 시작하고, 변경 통제 절차가 자리 잡은 뒤 자동화 옵션을 하나씩 켜는 순서를 권합니다. 이 글의 설정은 공식 문서를 바탕으로 한 예시이므로 반드시 시험 환경에서 검증한 뒤 적용하세요.

<h3 class="references-heading">참고 자료</h3>

- [Argo CD 공식 문서](https://argo-cd.readthedocs.io/en/stable/)
- [Argo CD: Getting Started](https://argo-cd.readthedocs.io/en/stable/getting_started/)
- [Argo CD: Automated Sync Policy](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)
- [Argo CD: Sync Phases and Waves](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/)
- [Argo CD: ApplicationSet](https://argo-cd.readthedocs.io/en/stable/operator-manual/applicationset/)
- [Argo CD: Projects](https://argo-cd.readthedocs.io/en/stable/user-guide/projects/)
- [OpenGitOps: GitOps Principles](https://opengitops.dev/)
- [Kubernetes 공식 문서: Controllers](https://kubernetes.io/docs/concepts/architecture/controller/)
- [Kustomize 공식 문서](https://kubectl.docs.kubernetes.io/references/kustomize/)
