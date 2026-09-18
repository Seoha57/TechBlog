---
layout: post
title: "OpenTofu로 인프라 변경과 상태를 관리하는 방법"
date: 2026-09-17 00:00:00 +0900
categories: [infrastructure]
tags: [infrastructure, opentofu, iac, state, change-management]
---

클라우드 서버, 네트워크, 데이터베이스를 콘솔에서 직접 만들고 수정할 수는 있습니다. 하지만 운영자가 늘고 환경이 dev·stage·prod로 나뉘면 “누가 무엇을 바꿨는지”, “현재 설정이 의도한 상태와 같은지”, “같은 인프라를 다시 만들 수 있는지”를 관리하기 어려워집니다. Infrastructure as Code, 즉 IaC는 인프라의 원하는 상태를 코드로 선언하고 Git 이력과 자동화된 실행으로 관리하는 방식입니다.

OpenTofu는 사람이 읽을 수 있는 설정 파일로 클라우드와 온프레미스 리소스를 정의·관리하는 IaC 도구입니다. 이 글에서는 IaC, plan, apply, state가 무엇인지부터 설명합니다. 특정 회사 인프라에 OpenTofu를 적용한 경험이나 성능 결과를 주장하는 글이 아니라, 공식 문서를 기반으로 한 학습용 정리입니다.

<section class="quick-answers"><p class="quick-label">먼저 답하면</p><div class="quick-answer"><h3>Q. OpenTofu는 서버를 만드는 스크립트인가요?</h3><p>A. 단순 실행 스크립트보다 선언형 도구에 가깝습니다. “VPC 하나, 서브넷 두 개, DB 하나”처럼 원하는 상태를 작성하면 OpenTofu가 현재 상태와 비교해 필요한 변경 계획을 만듭니다.</p></div><div class="quick-answer"><h3>Q. state는 왜 필요한가요?</h3><p>A. 코드에 적힌 리소스와 실제 생성된 리소스를 연결하기 위해 필요합니다. state에는 실제 리소스 ID와 관리 대상 정보가 들어갈 수 있으므로 저장 위치·권한·잠금이 중요합니다.</p></div><div class="quick-answer"><h3>Q. IaC를 쓰면 수동 변경을 못 하나요?</h3><p>A. 기술적으로는 가능하지만, 코드와 실제 환경의 차이(drift)를 만들 수 있습니다. 긴급 변경은 절차를 남기고 이후 코드와 state를 일치시키는 관리가 필요합니다.</p></div></section>

<figure class="article-figure"><img src="{{ '/assets/images/opentofu-state-flow.svg' | relative_url }}" alt="OpenTofu plan 변경 검토 예시"><figcaption>이미지 출처: <a href="https://opentofu.org/docs/intro/core-workflow/">OpenTofu Core Workflow 문서</a>를 바탕으로 재구성</figcaption></figure>

## IaC는 무엇을 바꾸는가

IaC 이전에는 인프라 변경이 운영자의 콘솔 작업, 메신저 대화, 개인 메모에 남기 쉽습니다. 같은 서버를 새 환경에 재구성할 때 누락이 생기고, 장애 뒤 복구 과정에서 원래 설정을 찾기 어려울 수 있습니다. IaC는 인프라 구성을 코드로 버전 관리해 이 문제를 줄이려는 접근입니다.

예를 들어 “운영 DB가 있는 private subnet과 외부용 load balancer subnet을 만든다”는 요구사항을 코드로 표현할 수 있습니다. 코드 리뷰에서는 주소 범위, 태그, 접근 규칙을 확인하고, 변경 전에는 어떤 리소스가 생성·변경·삭제되는지 계획을 검토합니다. 이 흐름은 인프라 변경을 재현 가능하게 만들고, 변경관리·감사 관점에서 근거를 남기는 데도 도움이 됩니다.

OpenTofu 설정은 보통 `.tf` 파일로 작성합니다. 아래는 설명을 위한 최소 예시입니다.

```hcl
terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

resource "aws_s3_bucket" "logs" {
  bucket = "example-operation-logs"

  tags = {
    Environment = "dev"
    Owner       = "platform"
  }
}
```

이 코드는 S3 버킷 하나와 태그라는 원하는 상태를 선언합니다. 실제 Provider와 인증 방식, 버킷 이름 정책은 환경에 따라 다릅니다. 특히 예제에 실제 접근 키나 비밀번호를 넣어 Git에 올리면 안 됩니다. 민감한 값은 비밀 관리 시스템이나 CI의 Secret 기능으로 전달해야 합니다.

## plan과 apply를 구분하기

OpenTofu 작업에서 가장 중요한 습관은 `apply` 전에 `plan`을 읽는 것입니다.

```bash
tofu init
tofu plan
tofu apply
```

`init`은 Provider와 backend 등을 준비합니다. `plan`은 코드, state, 실제 인프라를 비교해 어떤 변경이 예정됐는지 보여줍니다. `apply`는 승인한 계획을 실제 인프라에 반영합니다. 운영 환경에서는 plan 결과를 CI에서 만들고, 리뷰·승인 후 같은 계획을 apply하는 구조를 고려할 수 있습니다.

예를 들어 plan에 “DB 인스턴스 교체”나 “보안 그룹 규칙 삭제”가 나타났는데 의도하지 않았다면 apply하면 안 됩니다. IaC는 변경을 자동화하지만, 잘못된 코드를 더 빠르게 반영할 수도 있습니다. 따라서 계획 검토와 롤백·복구 전략은 여전히 필요합니다.

## state는 현재를 기억하는 파일

State는 OpenTofu가 관리하는 리소스와 실제 인프라를 연결하는 기록입니다. 코드에는 `aws_s3_bucket.logs`라는 논리 이름이 있지만, 클라우드에는 실제 버킷 ID·속성·의존 관계가 존재합니다. OpenTofu는 state를 통해 그 연결을 기억하고 변경 계획을 계산합니다.

기본적으로 local state는 로컬 파일에 저장될 수 있습니다. 혼자 실습하는 환경에서는 편하지만, 팀 운영에는 위험할 수 있습니다. 서로 다른 사람이 각자 오래된 state로 실행하면 같은 리소스를 중복 생성하거나, 다른 사람의 변경을 덮어쓸 위험이 있습니다. OpenTofu 공식 문서는 팀 작업에서 remote state와 locking을 사용해 동시 변경을 조정하는 방식을 설명합니다.

```hcl
terraform {
  backend "s3" {
    bucket = "example-tofu-state"
    key    = "network/prod.tfstate"
    region = "ap-northeast-2"
  }
}
```

이 예시는 원격 backend의 개념을 보여주기 위한 것입니다. 실제 backend 설정에는 버킷 암호화, 접근 제어, 버전 관리, 잠금 지원, 네트워크 접근 경로를 함께 검토해야 합니다. state에는 리소스 정보와 민감한 값이 포함될 수 있으므로, 일반 코드 저장소처럼 공개하거나 아무나 읽을 수 있게 두면 안 됩니다.

## state locking은 왜 필요한가

두 명의 운영자가 동시에 같은 네트워크 설정에 `apply`를 실행한다고 생각해 보겠습니다. 한 사람은 subnet을 추가하고 다른 사람은 route table을 바꿉니다. 둘 다 같은 이전 state를 기준으로 실행하면 최종 상태가 의도와 달라지거나 state가 손상될 수 있습니다.

State locking은 state를 쓰는 작업 중에 다른 쓰기 작업이 동시에 시작하지 않도록 막는 기능입니다. OpenTofu 공식 문서는 backend가 지원하는 경우 쓰기 작업에서 자동 잠금을 사용하며, 잠금을 얻지 못하면 작업을 계속하지 않는다고 설명합니다. `force-unlock`은 잘못 쓰면 다른 작업자의 잠금을 풀 수 있으므로, 자신의 실패한 잠금임을 확인한 경우에만 매우 신중하게 사용해야 합니다.

| 개념 | 역할 | 운영 시 확인할 것 |
| --- | --- | --- |
| 코드 | 원하는 인프라 상태 | Git 리뷰, 모듈, Secret 분리 |
| Plan | 예상 변경 목록 | 생성·변경·삭제 항목 검토 |
| State | 관리 대상과 실제 리소스 연결 | 접근 권한, 백업, 민감 정보 |
| Remote backend | 팀이 state를 공유하는 저장소 | 암호화, 버전, 네트워크 |
| Locking | 동시 쓰기 방지 | backend 지원 여부, 강제 해제 절차 |

## drift와 수동 변경 관리

Drift는 코드가 의도한 상태와 실제 인프라 상태가 달라지는 현상입니다. 예를 들어 콘솔에서 보안 그룹 포트를 긴급하게 열었는데 코드에는 반영하지 않은 경우가 대표적입니다. 다음 plan에서 OpenTofu가 그 수동 변경을 되돌리려 하거나, 예상하지 못한 변경으로 표시할 수 있습니다.

수동 변경을 완전히 금지하기보다, 긴급 작업 이후에 변경 티켓과 코드 반영을 연결하는 규칙이 현실적입니다. 예를 들어 장애 대응 중 임시로 인스턴스 수를 늘렸다면, 안정화 후 어떤 코드와 state를 수정할지 정리해야 합니다. 운영 환경의 변경 경로를 IaC로 통일할수록 drift를 줄이고 원인 분석도 쉬워집니다.

## ITGC와 변경관리 관점

OpenTofu는 ITGC 자체가 아니라 인프라 변경 통제를 구현하는 한 방법입니다. Git Pull Request에는 누가 어떤 코드를 바꿨는지, CI plan에는 어떤 인프라 변경이 예상되는지, 승인 기록에는 누가 배포를 허용했는지 남길 수 있습니다. 이 기록은 서버·네트워크·DB 인프라 변경이 검토됐다는 증거의 일부가 될 수 있습니다.

하지만 자동화가 곧 통제를 보장하지는 않습니다. Production apply 권한이 너무 넓거나, state 버킷 접근 권한이 과도하거나, plan을 검토하지 않고 자동 실행하면 위험은 남습니다. 권한 분리, 승인 절차, 로그 보관, 비상 변경 절차를 조직의 요구사항에 맞춰 함께 설계해야 합니다.

<section class="quick-answers"><p class="quick-label">한계와 적용 기준</p><div class="quick-answer"><h3>Q. 작은 환경에도 OpenTofu가 필요한가요?</h3><p>A. 한두 개의 실습 리소스에는 설정 부담이 클 수 있습니다. 반복 생성, 여러 환경, 팀 협업, 변경 이력 관리가 필요해질 때 가치가 커집니다.</p></div><div class="quick-answer"><h3>Q. state를 Git에 저장해도 되나요?</h3><p>A. 권장하지 않습니다. state에는 리소스 상세 정보와 민감한 값이 포함될 수 있습니다. 접근 제어와 잠금을 제공하는 원격 backend를 검토하는 편이 안전합니다.</p></div><div class="quick-answer"><h3>Q. apply 실패 후 state를 강제로 고쳐도 되나요?</h3><p>A. `state push`나 force-unlock은 위험한 복구 수단입니다. 먼저 원격 state와 실제 리소스, 잠금 소유자를 확인하고 백업과 팀 합의 후 제한적으로 사용해야 합니다.</p></div></section>

OpenTofu를 배운다는 것은 `.tf` 문법만 외우는 일이 아닙니다. 코드·계획·state·실제 인프라의 관계와, 팀이 동시에 변경할 때 필요한 권한·잠금·검토 흐름을 이해하는 일입니다. 취준생이라면 작은 dev 환경에서 plan 결과를 읽고, state가 무엇을 기록하는지 확인하는 것부터 시작하면 좋습니다.

<h3 class="references-heading">참고 자료</h3>

- [OpenTofu 시작하기](https://opentofu.org/docs/v1.7/intro/)
- [OpenTofu State Storage and Locking](https://opentofu.org/docs/language/state/backends/)
- [OpenTofu State Locking](https://opentofu.org/docs/language/state/locking/)
- [OpenTofu Remote State](https://opentofu.org/docs/language/state/remote/)
