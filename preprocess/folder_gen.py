import os

base_dir = os.path.join("data", "spirit")

for i in range(1, 9):
    os.makedirs(os.path.join(base_dir, f"pin{i}"), exist_ok=True)

print("pin1 ~ pin8 폴더 생성 완료")