---
layout: post
title: "FlashAttention 입문: GPU 메모리 이동을 줄여 같은 결과를 더 빠르고 적은 메모리로 계산하는 어텐션"
categories: [AI]
tags: [ai, flashattention, attention, transformer, gpu, hbm, sram, tiling, online-softmax, long-context]
description: "FlashAttention(플래시 어텐션)이 무엇이고 왜 등장했는지, 표준 어텐션이 N×N 점수 행렬을 GPU 메모리에 쓰고 읽으며 느려지는 이유, 타일링과 온라인 softmax로 정확한 결과를 유지하는 원리, 역전파 재계산, FlashAttention-2·3의 차이, PyTorch와 Hugging Face에서 켜는 방법과 한계를 직접 실행한 파이썬 검증 코드와 함께 설명합니다."
---

## 먼저 답하기

### Q. FlashAttention은 무엇인가요?

A. FlashAttention(플래시 어텐션)은 트랜스포머(Transformer)의 핵심 연산인 어텐션(attention)을 "결과는 표준 방식과 똑같이, GPU 메모리를 훨씬 덜 오가면서" 계산하도록 다시 짜 놓은 알고리즘이자 GPU 커널(kernel, GPU에서 실행되는 연산 코드)입니다. 2022년 논문 「FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness」에서 제안되었습니다. 이름의 핵심은 "정확한(exact)"과 "IO 인식(IO-aware)"입니다. 근사(approximation)로 정확도를 포기하고 빠르게 만든 방법이 아니라, 계산 순서를 바꿔 데이터 이동량을 줄인 방법입니다. 이 글은 논문과 공식 문서를 바탕으로 정리한 학습 자료이며, 제가 직접 GPU에서 성능을 측정한 결과가 아닙니다. 다만 아래 「온라인 softmax를 코드로 확인하기」 절의 수치 검증은 실제로 실행한 결과입니다.

### Q. 왜 어텐션을 다시 짜야 했나요?

A. 표준 어텐션은 입력 길이가 N일 때 N×N 크기의 "점수 행렬"을 만들어 GPU의 큰 메모리(HBM)에 썼다가 다시 읽습니다. 길이가 4배가 되면 이 행렬은 16배가 되므로, 긴 입력에서 메모리가 부족해지고 속도도 계산 능력보다 메모리 이동에 막힙니다. FlashAttention은 이 큰 행렬을 아예 HBM에 만들지 않고, 작은 조각(타일) 단위로 빠른 온칩 메모리에서 계산을 끝냅니다. 자세한 원리는 아래 「표준 어텐션이 느려지는 이유」와 「타일링과 온라인 softmax」 절에서 다룹니다.

### Q. 정확도가 달라지지 않나요?

A. 수학적으로는 표준 어텐션과 같은 값을 계산합니다. 다만 부동소수점(floating point) 계산은 더하는 순서가 바뀌면 마지막 몇 자리가 달라질 수 있어서, 비트 단위로 똑같지는 않고 매우 작은 수치 오차가 생길 수 있습니다. 이 차이가 모델 품질에 영향을 주는지는 학습·추론 설정에 따라 확인해야 합니다. 이 점은 아래 「한계와 적용 기준 Q&A」에서 다시 다룹니다.

### Q. 항상 FlashAttention을 써야 하나요?

A. 아닙니다. 짧은 입력, 지원하지 않는 GPU, 특수한 마스크(mask, 가려 둘 위치 규칙)가 필요한 경우에는 이점이 작거나 쓸 수 없습니다. 반대로 긴 컨텍스트나 큰 배치에서 메모리가 병목이라면 첫 번째로 고려할 만합니다. 선택 기준은 아래 「한계와 적용 기준 Q&A」 절에서 정리합니다.

## 먼저 알아둘 기반 기술

이 절은 본문을 읽는 데 필요한 지식을 가장 밑바닥(어텐션 수식)에서부터 FlashAttention 직전(softmax의 분할 계산)까지 순서대로 쌓습니다. 각 소절 끝에는 그 개념이 본문의 어느 절에서 다시 쓰이는지 적었고, 절 마지막에 전체 연결 지도를 표로 정리했습니다.

### 어텐션: Query, Key, Value와 softmax

어텐션(attention)은 문장 속 각 단어(정확히는 토큰, token)가 "다른 어떤 토큰을 얼마나 참고할지"를 계산하는 연산입니다. 도서관에서 질문을 가지고 책을 찾는 상황에 비유할 수 있습니다. 질문이 Query(Q, 질의), 책 표지의 제목이 Key(K, 키), 책 속 내용이 Value(V, 값)입니다. 질문과 제목이 얼마나 잘 맞는지 점수를 매기고, 점수가 높은 책의 내용을 더 많이 섞어 답을 만듭니다. 수식으로는 점수 행렬 S = Q × Kᵀ / √d를 구하고, 각 행에 softmax(소프트맥스, 점수를 합이 1인 비율로 바꾸는 함수)를 적용해 P를 만든 뒤, 출력 O = P × V를 계산합니다. 여기서 d는 한 헤드(head, 어텐션을 여러 갈래로 나눈 단위 하나)의 차원 크기입니다.

토큰이 N개면 Q, K, V는 각각 N×d 크기이고, 점수 행렬 S와 P는 N×N 크기입니다. 이 N×N이 FlashAttention이 줄이려는 핵심 대상입니다. 이 수식을 모르면 "왜 길이의 제곱으로 커지는가"를 이해할 수 없습니다. 이 개념은 아래 「표준 어텐션이 느려지는 이유」 절에서 N×N 행렬의 크기 계산으로, 「타일링과 온라인 softmax」 절에서 타일 단위 계산의 대상으로 이어집니다.

```python
# 표준 어텐션(개념 코드): S와 P가 N×N 크기로 통째로 만들어진다
S = (Q @ K.T) / d ** 0.5          # [N, N]
P = softmax(S, axis=-1)           # [N, N]
O = P @ V                         # [N, d]
```

### 시퀀스 길이와 제곱 증가

시퀀스 길이(sequence length)는 한 번에 모델이 보는 토큰 수입니다. 어텐션의 점수 행렬 크기가 N²이므로, 길이가 2배가 되면 행렬은 4배, 8배가 되면 64배가 됩니다. 예를 들어 N=8,192일 때 점수 행렬 원소는 8,192² = 67,108,864개이고, 원소 하나가 fp16(16비트 부동소수점, 2바이트)이면 헤드 하나당 약 128MiB입니다. 헤드가 32개면 한 층에서만 약 4GiB이고, 학습에서는 층 수와 배치 크기가 곱해집니다. 계산식으로 직접 확인할 수 있습니다.

```bash
python3 -c "
N=8192; bytes_per=2; heads=32
one=N*N*bytes_per
print('per head MiB :', one/2**20)
print('32 heads GiB :', one*heads/2**30)"
# per head MiB : 128.0
# 32 heads GiB : 4.0
```

긴 문서 요약, 코드 저장소 분석, 에이전트의 긴 대화 기록처럼 컨텍스트가 길어지는 업무가 늘면서 이 제곱 증가가 실제 병목이 되었습니다. 이 개념은 아래 「표준 어텐션이 느려지는 이유」 절의 메모리 예산 계산과, 「업무 예시: 컨텍스트 길이와 메모리 예산 계산」 절에서 다시 쓰입니다.

### GPU 메모리 계층: HBM과 SRAM

GPU는 속도와 용량이 다른 여러 메모리를 가집니다. HBM(High Bandwidth Memory, 고대역폭 메모리)은 GPU 보드에 붙은 큰 메모리로 수십 GB 용량이지만 칩 바깥에 있어 접근이 상대적으로 느립니다. 우리가 흔히 말하는 "GPU 메모리 80GB"가 이것입니다. SRAM(Static RAM, 정적 램)은 GPU 칩 안의 연산 장치(SM, Streaming Multiprocessor) 옆에 있는 작은 온칩 메모리로 용량은 SM당 수백 KB 수준이지만 훨씬 빠릅니다. 논문은 NVIDIA A100 기준으로 HBM 용량 40~80GB와 대역폭 1.5~2.0TB/s, SM당 SRAM 192KB와 약 19TB/s를 제시합니다. 작업실 책상(SRAM)과 창고(HBM)에 비유하면, 책상은 좁지만 손이 바로 닿고 창고는 넓지만 다녀오는 데 시간이 걸립니다.

핵심은 "계산을 얼마나 빨리 하느냐"만큼 "창고를 몇 번 왕복하느냐"가 중요하다는 점입니다. FlashAttention이 "IO 인식"이라고 불리는 이유는 여기서 IO가 곧 HBM과 SRAM 사이의 데이터 이동이기 때문입니다. 이 개념은 아래 「표준 어텐션이 느려지는 이유」 절에서 읽기·쓰기 횟수 비교로, 「타일링과 온라인 softmax」 절에서 "타일이 SRAM에 들어가는 크기"라는 설계 조건으로 이어집니다. 앞서 소개한 vLLM 글의 PagedAttention이 KV Cache의 "저장 배치"를 다룬다면, FlashAttention은 어텐션 "계산 중 이동"을 다룬다는 점이 다릅니다.

### 메모리 바운드와 컴퓨트 바운드

어떤 연산의 속도를 정하는 제약이 연산 능력(FLOPS, 초당 부동소수점 연산 수)인지, 메모리 대역폭인지에 따라 컴퓨트 바운드(compute-bound)와 메모리 바운드(memory-bound)로 나눕니다. 큰 행렬 곱셈은 데이터 하나를 읽어 오면 곱셈을 많이 할 수 있어 컴퓨트 바운드이고, softmax나 마스킹, dropout처럼 원소마다 간단한 연산을 하는 작업은 읽고 쓰는 시간이 대부분이라 메모리 바운드입니다. 비유하면 요리사가 칼질(연산)은 빠른데 재료를 냉장고에서 가져오는 시간이 대부분인 상황입니다.

표준 어텐션의 중간 단계들(softmax, 마스크, dropout)이 바로 메모리 바운드 연산이며, 이들이 N×N 행렬을 HBM에 읽고 쓰기 때문에 전체가 느려집니다. FlashAttention은 이 연산들을 하나의 커널로 합쳐(fusion, 융합) 중간 결과를 HBM에 내리지 않습니다. 이 개념은 아래 「표준 어텐션이 느려지는 이유」 절의 병목 분석과, 「문제 점검 절차」 절에서 "속도가 안 빨라지는 이유"를 판단하는 기준으로 쓰입니다.

### softmax의 수치 안정성과 분할 계산

softmax는 점수 s₁…sₙ에 대해 exp(sᵢ) / Σ exp(sⱼ)를 계산합니다. 점수가 크면 exp가 부동소수점 한계를 넘어 무한대(overflow)가 되므로, 실제 구현은 먼저 최댓값 m을 빼서 exp(sᵢ − m) / Σ exp(sⱼ − m)로 계산합니다. 결과는 수학적으로 같고 수치적으로 안정적입니다. 문제는 이 방식이 "행 전체의 최댓값과 합"을 알아야 한다는 점입니다. 즉 한 행의 모든 점수를 먼저 다 구해야 softmax를 시작할 수 있어서, 행을 조각으로 나눠 처리하기 어렵습니다.

이것을 해결하는 것이 "온라인 softmax(online softmax)"입니다. 조각을 하나씩 읽으며 지금까지의 최댓값과 합을 계속 갱신하고, 최댓값이 바뀌면 이전 합을 보정 계수로 다시 맞춰 줍니다. 이 아이디어가 있어야 N×N 행렬 없이 타일 단위 계산이 가능합니다. 이 개념은 아래 「타일링과 온라인 softmax」 절에서 갱신 공식으로, 「온라인 softmax를 코드로 확인하기」 절에서 실제 수치 일치 검증으로 이어집니다.

### 기존 방식과 비교

| 구분 | 표준 어텐션 | 근사 어텐션(희소·저랭크 등) | FlashAttention |
|---|---|---|---|
| 결과 정확성 | 정확 | 근사(품질 영향 가능) | 정확(수치 순서 차이만) |
| N×N 행렬 | HBM에 저장 | 구조에 따라 줄이거나 근사 | HBM에 저장하지 않음 |
| 추가 메모리 | N²에 비례 | 방식에 따라 다름 | N에 비례(통계값만) |
| 병목 해결 대상 | 해결 안 함 | 계산량(FLOPs) 줄이기 | 메모리 이동(IO) 줄이기 |
| 연산량(FLOPs) | N² | 줄어듦 | N²(그대로, 이동만 감소) |
| 적용 난도 | 기본 | 모델 재학습·검증 필요 | 커널 교체만으로 가능한 경우 많음 |

### 기반 개념과 본문 연결 지도

| 기반 개념 | 쓰이는 본문 절 | 그 절에서의 역할 |
|---|---|---|
| 어텐션 Q·K·V·softmax | 표준 어텐션이 느려지는 이유 | N×N 점수 행렬 크기와 단계 파악 |
| 어텐션 Q·K·V·softmax | 타일링과 온라인 softmax | 타일 단위로 계산할 대상 |
| 시퀀스 길이와 제곱 증가 | 표준 어텐션이 느려지는 이유 | 메모리 예산 계산 |
| 시퀀스 길이와 제곱 증가 | 업무 예시: 컨텍스트 길이와 메모리 예산 계산 | 길이별 점수 행렬 크기 비교 |
| GPU 메모리 계층 HBM·SRAM | 표준 어텐션이 느려지는 이유 | 읽기·쓰기 횟수 비교 |
| GPU 메모리 계층 HBM·SRAM | 타일링과 온라인 softmax | 타일이 SRAM에 들어가는 설계 조건 |
| 메모리 바운드·컴퓨트 바운드 | 표준 어텐션이 느려지는 이유 | softmax·마스크가 병목인 이유 |
| 메모리 바운드·컴퓨트 바운드 | 문제 점검 절차 | 속도가 안 오르는 경우 판단 |
| softmax 수치 안정성·분할 | 타일링과 온라인 softmax | 최댓값·합 갱신 공식 |
| softmax 수치 안정성·분할 | 온라인 softmax를 코드로 확인하기 | 표준 결과와의 일치 검증 |

## 표준 어텐션이 느려지는 이유

표준 구현은 어텐션을 여러 개의 독립된 커널로 나누어 실행합니다. 각 단계의 결과를 HBM에 쓰고, 다음 단계가 다시 읽어 옵니다. 앞서 기반 기술에서 본 메모리 바운드 연산이 중간에 끼어 있어 시간이 늘어납니다.

1. Q, K를 HBM에서 읽어 S = QKᵀ를 계산하고 S(N×N)를 HBM에 씁니다.
2. S를 HBM에서 읽어 softmax를 계산하고 P(N×N)를 HBM에 씁니다.
3. P와 V를 HBM에서 읽어 O = PV를 계산하고 O를 HBM에 씁니다.

N×N 행렬이 쓰기 두 번, 읽기 두 번(마스크·dropout이 있으면 더 많이) 오갑니다. 논문은 표준 어텐션의 HBM 접근량이 N²에 비례한다고 분석하고, FlashAttention의 HBM 접근량은 N²d²/M(M은 SRAM 크기)에 비례해 훨씬 적다고 보입니다. 이는 이론적 상한 분석이며 실제 속도는 하드웨어와 설정에 따라 달라집니다. 일반적으로 d(64~128)는 작고 M(수십~수백 KB)이 d²보다 크기 때문에 접근량이 크게 줄어듭니다.

<figure class="article-figure"><img src="{{ '/assets/images/flashattention-tiling-online-softmax.svg' | relative_url }}" alt="표준 어텐션은 N×N 점수 행렬을 HBM에 쓰고 읽지만, FlashAttention은 K와 V를 타일로 나누어 SRAM에서 온라인 softmax로 누적하고 최종 출력만 HBM에 쓰는 비교 도식"><figcaption>표준 어텐션과 FlashAttention의 메모리 이동 비교. 이미지 출처: 직접 제작</figcaption></figure>

속도 병목뿐 아니라 메모리 용량 병목도 있습니다. 학습에서는 역전파(backpropagation, 오차를 거꾸로 전파해 가중치를 고치는 계산)를 위해 N×N 행렬을 저장해 둬야 하므로, 긴 입력에서는 이 행렬이 GPU 메모리를 잠식합니다. 앞서 계산한 N=8,192의 4GiB(한 층 기준)가 층 수만큼 쌓이는 상황입니다. 그래서 FlashAttention 이전에는 길이를 줄이거나 배치를 줄이거나 근사 어텐션으로 바꾸는 선택이 흔했습니다.

## 타일링과 온라인 softmax

FlashAttention의 핵심은 두 가지입니다. 첫째 타일링(tiling, 큰 행렬을 작은 조각으로 나누어 처리), 둘째 온라인 softmax입니다. Q를 행 방향 블록으로, K와 V를 열 방향 블록으로 나눕니다. 각 Q 블록에 대해 K·V 블록을 하나씩 SRAM으로 불러와서 작은 점수 조각을 계산하고, 그 즉시 softmax 통계와 출력 누적값을 갱신합니다. 점수 조각은 SRAM 안에서만 쓰이고 버려지므로 N×N 행렬은 HBM에 만들어지지 않습니다. 타일 크기는 Q·K·V 블록과 점수 조각이 SRAM에 함께 들어가도록 정합니다. 기반 기술에서 본 "책상에 올릴 수 있는 만큼만 가져온다"는 조건입니다.

한 행에 대해 지금까지 본 조각들의 상태를 세 가지로 기억합니다. m은 지금까지의 점수 최댓값, ℓ(엘)은 exp(s − m)의 합, O는 아직 정규화하지 않은 출력 누적값입니다. 새 조각 j가 들어올 때 갱신은 다음과 같습니다.

```text
S_j     = Q_i · K_jᵀ / √d                  # 이번 조각의 점수 (SRAM 안)
m_new   = max(m, rowmax(S_j))
P_j     = exp(S_j − m_new)
α       = exp(m − m_new)                   # 이전 값 보정 계수
ℓ_new   = α · ℓ + rowsum(P_j)
O_new   = α · O + P_j · V_j
m, ℓ, O = m_new, ℓ_new, O_new
# 모든 조각을 본 뒤  O_final = O / ℓ
```

보정 계수 α가 핵심입니다. 새 조각에서 더 큰 점수가 나와 최댓값이 바뀌면, 이전에 계산해 둔 합과 출력은 "예전 최댓값 기준"이므로 α = exp(예전 m − 새 m)를 곱해 새 기준으로 환산합니다. 최댓값이 바뀌지 않으면 α = 1입니다. 이렇게 하면 전체 점수를 한 번에 보지 않고도, 마지막에 표준 softmax와 같은 결과가 나옵니다. 마지막에 한 번만 ℓ로 나눠 정규화합니다.

이 방식은 계산량(FLOPs)을 줄이지 않습니다. 오히려 보정 계수 계산 때문에 약간 늘어납니다. 대신 HBM에 읽고 쓰는 양을 크게 줄여 메모리 바운드 병목을 해소합니다. 즉 "덜 계산해서 빠른 것"이 아니라 "덜 옮겨서 빠른 것"이라는 점이 이 기술을 이해하는 중심입니다. 각 Q 블록의 계산은 서로 독립이므로 GPU의 여러 SM에 나누어 병렬로 실행할 수 있습니다.

## 온라인 softmax를 코드로 확인하기

위 공식이 정말 표준 어텐션과 같은 결과를 내는지는 작은 크기에서 직접 확인할 수 있습니다. 아래 순수 파이썬 코드는 N=64, d=8, 타일 크기 16으로 두 방식을 계산해 최대 오차를 비교합니다. 저는 이 코드를 실제로 실행했고, 결과는 부동소수점 반올림 수준의 차이였습니다. GPU 커널이 아니라 알고리즘 검증용이므로 속도 비교용이 아닙니다.

```python
import math, random
random.seed(0)
N, d, B = 64, 8, 16
R = lambda: [[random.gauss(0, 1) for _ in range(d)] for _ in range(N)]
Q, K, V = R(), R(), R()
dot = lambda a, b: sum(x * y for x, y in zip(a, b)) / math.sqrt(d)

def standard():
    out = []
    for i in range(N):
        s = [dot(Q[i], K[j]) for j in range(N)]
        m = max(s)
        p = [math.exp(x - m) for x in s]
        z = sum(p)
        out.append([sum(p[j] * V[j][c] for j in range(N)) / z for c in range(d)])
    return out

def tiled():
    out = []
    for i in range(N):
        m, l, o = -math.inf, 0.0, [0.0] * d
        for j0 in range(0, N, B):
            s = [dot(Q[i], K[j]) for j in range(j0, j0 + B)]
            mn = max(m, max(s))
            a = math.exp(m - mn) if m > -math.inf else 0.0
            p = [math.exp(x - mn) for x in s]
            l = a * l + sum(p)
            o = [a * o[c] + sum(p[t] * V[j0 + t][c] for t in range(B)) for c in range(d)]
            m = mn
        out.append([x / l for x in o])
    return out

A, T = standard(), tiled()
print("max abs diff:", max(abs(a - b) for ra, rt in zip(A, T) for a, b in zip(ra, rt)))
```

```text
max abs diff: 3.885780586188048e-16
```

차이가 약 4×10⁻¹⁶으로 배정밀도(double) 반올림 오차 수준입니다. 타일 크기 B를 바꿔도(단 N을 나누어떨어지게) 같은 결과가 나옵니다. 이 실험이 보여 주는 것은 "순서를 쪼개도 결과가 같다"는 수학적 성질이며, fp16이나 bf16 같은 낮은 정밀도에서는 반올림 오차가 더 크게 보일 수 있다는 점은 알아 두어야 합니다.

## 역전파와 재계산

학습에서는 역전파가 필요합니다. 표준 구현은 순전파에서 만든 N×N 행렬 P를 저장해 두었다가 역전파에서 씁니다. FlashAttention은 이 행렬을 저장하지 않습니다. 대신 순전파에서 행마다의 통계(최댓값 m과 합 ℓ, 합쳐서 로그-합-지수 값 하나)와 출력 O만 저장하고, 역전파에서 Q, K, V 블록을 다시 SRAM으로 불러와 점수 조각을 재계산(recomputation)합니다. 일반 상식으로는 "다시 계산하면 느려질 것"이지만, 계산은 빠르고 HBM 이동이 느리기 때문에 재계산이 저장·읽기보다 이득인 경우가 많다는 것이 논문의 설명입니다. 이 방식은 학습 시 활성값 메모리를 N²에서 N 수준으로 줄이는 효과가 있습니다. 같은 철학의 기법으로 활성값 체크포인팅(gradient checkpointing, 일부 중간값을 버리고 필요할 때 다시 계산)이 있습니다.

추론(inference, 학습된 모델로 답을 만드는 단계)만 한다면 역전파가 없으므로 이 부분은 해당되지 않고, 순전파의 메모리·속도 이점만 적용됩니다. 다만 LLM 추론의 디코딩(decoding, 토큰을 하나씩 생성하는 단계)은 새 토큰 하나의 Q가 과거 전체 KV Cache를 읽는 구조라서 메모리 바운드 성격이 달라집니다. 이 경우를 위해 KV를 여러 조각으로 나눠 병렬 처리하는 변형(Flash-Decoding 등)이 별도로 논의됩니다.

## FlashAttention-2와 FlashAttention-3에서 달라진 점

초기 버전 이후 개선판이 이어졌습니다. 아래는 각 논문이 밝힌 개선 방향의 요약이며, 제가 직접 비교 측정한 결과가 아닙니다.

| 구분 | FlashAttention(2022) | FlashAttention-2(2023) | FlashAttention-3(2024) |
|---|---|---|---|
| 핵심 목표 | 정확한 어텐션의 IO 최소화 | GPU 활용률 향상 | 최신 GPU(Hopper) 기능 활용 |
| 개선 방향 | 타일링·재계산·커널 융합 | 비행렬곱 연산 감소, 시퀀스 방향 병렬화, 워프 간 작업 분할 개선 | 비동기 실행(데이터 이동과 연산 겹침), 저정밀(FP8) 지원 |
| 주 대상 GPU | Ampere(A100) 등 | Ampere 이상 | Hopper(H100) |
| 설치·사용 | `flash-attn` 패키지 | `flash-attn` 2.x | 별도 빌드·전용 지원 |

FlashAttention-2는 알고리즘의 큰 틀은 같고, 행렬 곱셈이 아닌 연산(예: 보정 계수 곱셈)의 비중을 줄이며, 한 어텐션 헤드의 계산을 시퀀스 길이 방향으로도 나눠 병렬화하고, 스레드 블록 안에서 워프(warp, GPU 스레드 32개 묶음) 간 작업을 나누는 방식을 개선했다고 설명합니다. FlashAttention-3는 Hopper 세대 GPU의 텐서 코어와 비동기 데이터 이동 기능을 활용해 연산과 이동을 겹치고, FP8 저정밀을 지원하는 방향입니다. 어느 버전이 내 환경에서 빠른지는 GPU 종류, 헤드 차원, 시퀀스 길이에 따라 다르므로 직접 벤치마크해야 합니다.

## 인과 마스크와 타일 건너뛰기

대화형 언어 모델(GPT 계열처럼 앞 토큰만 보고 다음 토큰을 예측하는 모델)은 인과 마스크(causal mask)를 씁니다. i번째 토큰은 자기 자신과 그 앞의 토큰만 볼 수 있고, 뒤의 토큰 점수는 −∞로 가려 softmax 후 0이 되게 합니다. 표준 구현에서는 N×N 점수 행렬을 전부 계산한 뒤 위쪽 삼각형을 가리므로, 어차피 버릴 절반의 계산과 저장을 합니다. 타일 방식에서는 이 낭비를 구조적으로 피할 수 있습니다. 어떤 K 타일이 현재 Q 블록보다 전부 "미래"에 있다면 그 타일은 점수 계산 자체를 건너뛰면 되고, 대각선에 걸친 타일만 마스크를 적용하면 됩니다. 논문도 블록 단위로 마스크된 영역을 건너뛰는 방식(block-sparse 변형 포함)을 다룹니다.

이 성질 덕분에 `is_causal=True`로 호출하는 것이 임의의 마스크 텐서를 넘기는 것보다 대체로 유리합니다. 커널이 "어디를 건너뛸지"를 규칙으로 알 수 있기 때문입니다. 반대로 패딩이나 문서 경계를 표현하는 임의 형태의 불리언·덧셈 마스크를 넘기면, 일부 백엔드는 FlashAttention 경로를 쓰지 못하고 다른 구현으로 대체합니다. 앞서 「문제 점검 절차」 표에서 마스크가 폴백의 원인으로 나온 이유입니다. 가변 길이 배치를 다룰 때는 패딩을 마스크로 처리하는 대신 길이 정보(누적 길이 배열)를 직접 받는 가변 길이 전용 인터페이스를 제공하는 구현도 있으므로, 사용하는 라이브러리의 문서를 확인하는 것이 좋습니다.

```python
# 인과 마스크: 규칙으로 전달(커널이 위 삼각형 타일을 건너뛸 수 있음)
out = F.scaled_dot_product_attention(q, k, v, is_causal=True)

# 임의 마스크 텐서: 유연하지만 지원 백엔드가 제한될 수 있음
mask = torch.ones(8192, 8192, dtype=torch.bool, device="cuda").tril()
out = F.scaled_dot_product_attention(q, k, v, attn_mask=mask)
```

## 멀티헤드·GQA와 헤드 차원이 미치는 영향

어텐션은 보통 여러 헤드로 나뉘어 병렬 계산됩니다. 헤드마다 독립적인 N×N 행렬이 생기므로 헤드 수가 많을수록 표준 방식의 메모리 부담이 선형으로 늘어났고, FlashAttention에서는 헤드별 계산이 서로 독립이라 GPU의 병렬 자원에 자연스럽게 나눠 담깁니다. 최근 모델이 쓰는 GQA(Grouped-Query Attention, 그룹 쿼리 어텐션)는 여러 Query 헤드가 하나의 Key·Value 헤드를 공유하게 해 KV Cache 크기를 줄이는 구조입니다. 이는 FlashAttention과 충돌하지 않고 함께 쓰이며, 커널 쪽에서는 K·V 헤드를 여러 Q 헤드가 재사용하도록 지원하는 형태로 구현됩니다.

헤드 차원 d도 중요한 조건입니다. 타일이 SRAM에 들어가야 하므로 d가 커지면 한 번에 올릴 수 있는 타일이 작아지고, 어떤 구현은 지원하는 d의 범위를 제한합니다(예: 64, 128, 256 등). 새 모델을 도입할 때 헤드 차원이 사용하려는 커널의 지원 범위 안인지 확인하지 않으면, 조용히 느린 경로로 빠질 수 있습니다. 이런 확인은 코드 한 줄이면 됩니다.

```python
head_dim = model.config.hidden_size // model.config.num_attention_heads
kv_heads = getattr(model.config, "num_key_value_heads", model.config.num_attention_heads)
print("head_dim:", head_dim, " q_heads:", model.config.num_attention_heads, " kv_heads:", kv_heads)
```

## 실습 예시: PyTorch와 Hugging Face에서 켜기

직접 CUDA 커널을 작성할 필요는 없습니다. PyTorch는 `torch.nn.functional.scaled_dot_product_attention`(SDPA) 함수를 제공하고, 입력과 하드웨어 조건이 맞으면 내부에서 FlashAttention 계열 커널을 자동으로 고릅니다. 공식 문서에 따르면 SDPA는 FlashAttention, 메모리 효율 어텐션, 기본 수학 구현(math) 같은 백엔드 중에서 선택합니다. 아래는 개념 확인용 예시이며 CUDA GPU가 필요합니다.

```python
import torch
import torch.nn.functional as F

q = torch.randn(1, 32, 8192, 128, device="cuda", dtype=torch.float16)
k = torch.randn_like(q)
v = torch.randn_like(q)

out = F.scaled_dot_product_attention(q, k, v, is_causal=True)
print(out.shape)  # torch.Size([1, 32, 8192, 128])
```

특정 백엔드만 쓰도록 제한해 실제로 FlashAttention이 선택되는지 점검할 수도 있습니다. 조건이 안 맞으면 오류가 나서, 자동 선택이 조용히 느린 경로로 빠졌는지 알아내는 용도로 유용합니다.

```python
from torch.nn.attention import sdpa_kernel, SDPBackend

with sdpa_kernel(SDPBackend.FLASH_ATTENTION):
    out = F.scaled_dot_product_attention(q, k, v, is_causal=True)
# 지원 조건(dtype, 헤드 차원, GPU 세대 등)이 안 맞으면 RuntimeError 발생
```

Hugging Face Transformers에서는 모델을 불러올 때 어텐션 구현을 지정합니다. `flash_attention_2`를 지정하려면 `flash-attn` 패키지 설치와 지원 GPU, fp16 또는 bf16 데이터 타입이 필요하다고 안내합니다. 가장 간단한 선택은 `sdpa`로, 별도 패키지 없이 PyTorch 내장 경로를 사용합니다. 모델 이름은 예시입니다.

```python
from transformers import AutoModelForCausalLM
import torch

model = AutoModelForCausalLM.from_pretrained(
    "your-org/your-model",
    torch_dtype=torch.bfloat16,
    attn_implementation="sdpa",          # 또는 "flash_attention_2"
    device_map="auto",
)
```

```bash
# FlashAttention-2 패키지 설치(빌드에 시간이 걸리고 CUDA 툴체인이 필요)
pip install flash-attn --no-build-isolation
python -c "import flash_attn; print(flash_attn.__version__)"
```

vLLM 같은 서빙 엔진은 내부적으로 FlashAttention 계열 백엔드를 선택하는 설정을 제공합니다. 어떤 백엔드가 쓰였는지는 시작 로그에 표시되므로 서빙 환경에서는 로그부터 확인하세요.

## 업무 예시: 컨텍스트 길이와 메모리 예산 계산

가상의 사내 "문서 요약 서비스"에서 입력 길이를 4,096에서 16,384 토큰으로 늘리려는 상황을 가정합니다. 이 예시는 설명용 가상 시나리오이며 실제 측정이 아닙니다. 모델은 헤드 32개, 층 32개, fp16이라고 둡니다. 표준 어텐션으로 학습한다면 점수 행렬(N×N)만으로 필요한 메모리를 계산해 봅니다.

```bash
python3 -c "
heads=32; layers=32; b=2
for N in (4096, 8192, 16384):
    per_layer=N*N*b*heads
    print(f'N={N:6d}  per-layer GiB={per_layer/2**30:7.2f}  all-layers GiB={per_layer*layers/2**30:8.1f}')"
# N=  4096  per-layer GiB=   1.00  all-layers GiB=    32.0
# N=  8192  per-layer GiB=   4.00  all-layers GiB=   128.0
# N= 16384  per-layer GiB=  16.00  all-layers GiB=   512.0
```

배치 크기 1에서도 16,384에서는 점수 행렬만 512GiB에 이릅니다. 이는 모든 층의 점수 행렬을 동시에 저장한다고 가정한 상한 계산이며(실제 구현은 일부 재계산·정밀도 설정으로 다를 수 있음), 길이가 4배가 되면 16배가 된다는 증가 규모를 보여 주는 것이 목적입니다. FlashAttention은 이 행렬을 저장하지 않으므로 어텐션 때문에 늘어나는 활성값 메모리가 길이에 비례하는 수준으로 줄어듭니다. 다만 이것이 모델 전체 메모리가 길이에 비례한다는 뜻은 아닙니다. 가중치, 옵티마이저 상태, 다른 층의 활성값, 추론에서의 KV Cache는 따로 계산해야 합니다.

따라서 업무적 의사결정은 이렇게 정리할 수 있습니다. 첫째, 길이를 늘리기 전에 현재 병목이 어텐션 활성값인지 KV Cache인지 가중치인지 구분합니다. 둘째, 어텐션 활성값이 병목이면 SDPA 또는 FlashAttention 백엔드를 켠 상태로 시험 환경에서 최대 길이를 다시 측정합니다. 셋째, 서비스 품질은 별도 평가 세트로 확인합니다. 어텐션 커널을 바꿔도 이론상 결과는 같지만, 낮은 정밀도와 합산 순서 차이를 회귀 평가로 확인하는 것이 안전합니다. 앞서 LLM 평가 회귀 글에서 다룬 방식으로 전후 결과를 비교하면 됩니다.

## 문제 점검 절차

FlashAttention을 켰는데 기대한 효과가 없을 때는 아래 순서로 좁힙니다. 앞서 기반 기술에서 본 메모리 바운드·컴퓨트 바운드 구분이 첫 번째 판단 기준입니다.

| 증상 | 가능한 원인 | 먼저 볼 것 |
|---|---|---|
| 속도가 거의 그대로 | 입력이 짧아 어텐션이 전체의 작은 부분 | 프로파일러로 어텐션의 시간 비중 |
| 속도가 그대로이거나 느림 | 조건 불일치로 math 백엔드로 폴백 | `sdpa_kernel`로 강제 지정해 오류 확인 |
| `flash-attn` 설치 실패 | CUDA 툴체인·PyTorch 버전 불일치, 빌드 메모리 부족 | 공식 설치 요건, 미리 빌드된 휠 |
| dtype 관련 오류 | fp32 입력(커널은 fp16·bf16 중심) | 모델·입력 dtype을 fp16·bf16으로 |
| 마스크 관련 오류·폴백 | 임의 마스크는 지원 제한 | `is_causal` 사용 가능 여부, 마스크 형태 |
| 결과가 미세하게 다름 | 합산 순서·정밀도 차이 | 허용 오차를 정해 회귀 평가 |
| OOM이 여전히 발생 | 병목이 KV Cache·가중치·옵티마이저 | 메모리 구성요소별 분해 |

```python
# 어떤 백엔드가 가능한지 점검하는 예시
import torch
print(torch.cuda.get_device_name(0), torch.cuda.get_device_capability(0))
print("flash sdp enabled :", torch.backends.cuda.flash_sdp_enabled())
print("mem-eff sdp enabled:", torch.backends.cuda.mem_efficient_sdp_enabled())
print("math sdp enabled   :", torch.backends.cuda.math_sdp_enabled())
```

```bash
# 시간 비중 확인: 프로파일러로 어텐션 커널 이름 찾기
python - <<'EOF'
import torch
from torch.profiler import profile, ProfilerActivity
# ... q, k, v 준비 후
with profile(activities=[ProfilerActivity.CUDA]) as prof:
    torch.nn.functional.scaled_dot_product_attention(q, k, v, is_causal=True)
print(prof.key_averages().table(sort_by="cuda_time_total", row_limit=5))
EOF
```

프로파일 결과의 커널 이름에 `flash`가 보이면 FlashAttention 계열 커널이 실행된 것이고, 여러 개의 작은 커널(`softmax`, `bmm` 등)로 나뉘어 보이면 math 경로일 가능성이 큽니다. 이 확인 없이 "켰으니 빨라졌겠지"라고 가정하면 폴백을 놓치기 쉽습니다.

## 한계와 적용 기준 Q&A

### Q. FlashAttention이 어텐션의 N² 계산량을 없애 주나요?

A. 아닙니다. 연산량(FLOPs)은 여전히 N²에 비례합니다. 줄어드는 것은 HBM 접근량과 추가 메모리입니다. 그래서 길이가 매우 길어지면 계산 시간 자체는 여전히 제곱으로 늘어납니다. 계산량 자체를 줄이려면 슬라이딩 윈도우(sliding window, 가까운 토큰만 참조)나 희소 어텐션 같은 구조 변경이 필요하고, 이는 모델 설계의 문제이며 품질 평가가 필요합니다.

### Q. 어떤 GPU와 dtype에서 쓸 수 있나요?

A. 버전마다 요구 조건이 다릅니다. 일반적으로 FlashAttention-2는 Ampere 이상 NVIDIA GPU와 fp16·bf16을 대상으로 하고, FlashAttention-3는 Hopper를 대상으로 합니다. 조건이 맞지 않으면 PyTorch SDPA는 메모리 효율 어텐션이나 math 구현으로 대체합니다. 정확한 지원 범위는 사용하는 버전의 공식 저장소와 문서에서 확인해야 하며, 이 글의 표는 일반적인 방향을 요약한 것입니다.

### Q. 결과가 표준 어텐션과 완전히 같은가요?

A. 수학적으로는 같지만 비트 단위로는 같지 않을 수 있습니다. 합산 순서와 낮은 정밀도 때문에 마지막 자리 오차가 달라집니다. 특히 학습에서는 이런 차이가 누적되어 학습 곡선이 미세하게 달라질 수 있습니다. 모델 교체나 커널 변경 때는 전후 평가 세트와 허용 오차를 정해 두고 비교하는 것이 안전합니다.

### Q. KV Cache나 PagedAttention과는 어떤 관계인가요?

A. 서로 다른 문제를 풉니다. FlashAttention은 어텐션 계산 중 HBM·SRAM 사이 이동을 줄이고, PagedAttention은 추론 시 KV Cache를 조각내어 메모리 낭비를 줄입니다. 서빙 엔진은 보통 둘을 함께 사용합니다. 어느 쪽이 병목인지는 학습인지 추론인지, 프리필(prefill, 입력 프롬프트를 한 번에 처리)인지 디코딩인지에 따라 다릅니다. 프리필은 큰 행렬 연산이라 FlashAttention의 효과가 크고, 디코딩은 KV Cache 읽기가 지배적이라 다른 최적화의 비중이 커집니다.

### Q. 짧은 문장만 다루는 서비스에도 도움이 되나요?

A. 효과가 작을 가능성이 큽니다. 입력이 수백 토큰 수준이면 N×N 행렬 자체가 작아서 HBM 이동이 전체 시간에서 차지하는 비중도 작고, 모델의 대부분 시간은 피드포워드(feed-forward, 어텐션 뒤의 완전연결 층)와 가중치 읽기에 쓰입니다. 이런 경우 어텐션 커널을 바꿔도 전체 지연 시간이 거의 변하지 않을 수 있습니다. 그래서 "최신 기술이니 무조건 켠다"보다 프로파일러로 어텐션의 시간 비중을 먼저 확인하고, 비중이 클 때(긴 컨텍스트, 큰 배치, 학습) 우선순위를 높이는 판단이 합리적입니다. 켜서 손해 볼 일은 드물지만, 설치·빌드 복잡도와 버전 고정 부담이라는 운영 비용은 있다는 점도 함께 고려하세요.

### Q. 도입 전 체크리스트가 있나요?

A. 다음 항목을 점검해 보세요.

- 현재 병목이 어텐션 활성값인지 KV Cache·가중치·옵티마이저인지 구분했는가
- GPU 세대와 dtype이 사용하려는 버전의 지원 조건에 맞는가
- 먼저 PyTorch SDPA(`attn_implementation="sdpa"`)로 시험하고 필요할 때 `flash-attn`을 추가하는가
- `sdpa_kernel`이나 프로파일러로 실제 사용된 백엔드를 확인했는가
- 사용하는 마스크 형태(causal, 패딩, 커스텀)가 지원되는가
- 전후 평가 세트로 결과 차이가 허용 오차 안인지 확인했는가
- 길이별 메모리·지연 시간을 시험 환경에서 직접 측정했는가
- 패키지 버전(PyTorch, CUDA, `flash-attn`)을 고정해 재현 가능하게 했는가

## 마무리

FlashAttention의 핵심은 "어텐션의 수식은 그대로 두고, 계산 순서를 바꿔 GPU의 느린 메모리를 덜 오가게 한다"는 것입니다. 타일링으로 N×N 점수 행렬을 HBM에 만들지 않고, 온라인 softmax로 조각마다 통계를 갱신하며, 역전파에서는 재계산으로 저장을 줄입니다. 연산량이 줄어드는 것이 아니라 이동량이 줄어든다는 점, 그리고 효과가 GPU·길이·마스크 조건에 달려 있다는 점을 기억하고, 먼저 SDPA로 시험한 뒤 실제 사용된 백엔드를 확인하는 순서를 권합니다. 이 글의 성능 관련 설명은 논문과 공식 문서의 내용을 요약한 것이며 직접 측정한 결과가 아닙니다.

<h3 class="references-heading">참고 자료</h3>

- [FlashAttention 논문 (Dao et al., 2022)](https://arxiv.org/abs/2205.14135)
- [FlashAttention-2 논문 (Dao, 2023)](https://arxiv.org/abs/2307.08691)
- [FlashAttention-3 논문 (Shah et al., 2024)](https://arxiv.org/abs/2407.08608)
- [Online normalizer calculation for softmax (Milakov & Gimelshein, 2018)](https://arxiv.org/abs/1805.02867)
- [Attention Is All You Need (Vaswani et al., 2017)](https://arxiv.org/abs/1706.03762)
- [PyTorch: scaled_dot_product_attention 문서](https://docs.pytorch.org/docs/stable/generated/torch.nn.functional.scaled_dot_product_attention.html)
- [Hugging Face Transformers: GPU 추론 최적화(어텐션 구현)](https://huggingface.co/docs/transformers/perf_infer_gpu_one)
