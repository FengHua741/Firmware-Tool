import json
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from PIL import Image, ImageTk
import os

class CoordinateEditor:
    def __init__(self, root):
        self.root = root
        self.root.title("图像坐标编辑器")
        self.root.geometry("1200x800")
        
        # 数据存储
        self.data = None
        self.image_path = None
        self.original_image = None
        self.photo_image = None
        self.canvas_image = None
        self.dragging = False
        self.drag_item = None
        self.drag_start_x = 0
        self.drag_start_y = 0
        self.rectangles = {}  # 存储画布上的矩形对象
        self.texts = {}       # 存储画布上的文本对象
        self.current_category = None
        self.zoom_factor = 1.0
        self.image_width = 0
        self.image_height = 0
        self.move_mode = "single"  # 移动模式：single-单独移动，all-整体移动
        self.displayed_image_width = 0
        self.displayed_image_height = 0
        
        # 创建界面
        self.create_widgets()
        
    def create_widgets(self):
        # 菜单栏
        menubar = tk.Menu(self.root)
        file_menu = tk.Menu(menubar, tearoff=0)
        file_menu.add_command(label="打开图片", command=self.open_image)
        file_menu.add_command(label="打开JSON", command=self.open_json)
        file_menu.add_command(label="保存JSON", command=self.save_json)
        file_menu.add_separator()
        file_menu.add_command(label="退出", command=self.root.quit)
        menubar.add_cascade(label="文件", menu=file_menu)
        
        view_menu = tk.Menu(menubar, tearoff=0)
        view_menu.add_command(label="放大", command=self.zoom_in)
        view_menu.add_command(label="缩小", command=self.zoom_out)
        view_menu.add_command(label="重置缩放", command=self.reset_zoom)
        menubar.add_cascade(label="视图", menu=view_menu)
        
        self.root.config(menu=menubar)
        
        # 主框架
        main_frame = ttk.Frame(self.root, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        # 左侧控制面板
        control_frame = ttk.Frame(main_frame, width=250)
        control_frame.grid(row=0, column=0, sticky=(tk.N, tk.S), padx=(0, 10))
        control_frame.grid_propagate(False)
        
        # 文件信息
        self.image_label = ttk.Label(control_frame, text="未加载图片")
        self.image_label.pack(pady=(0, 10))
        
        self.json_label = ttk.Label(control_frame, text="未加载JSON")
        self.json_label.pack(pady=(0, 10))
        
        # 移动模式选择
        mode_frame = ttk.Frame(control_frame)
        mode_frame.pack(fill=tk.X, pady=(0, 10))
        
        ttk.Label(mode_frame, text="移动模式:").pack(anchor=tk.W)
        self.move_mode_var = tk.StringVar(value="single")
        
        mode_radio_frame = ttk.Frame(mode_frame)
        mode_radio_frame.pack(fill=tk.X, pady=(5, 0))
        
        ttk.Radiobutton(mode_radio_frame, text="单独移动", variable=self.move_mode_var, 
                       value="single", command=self.on_mode_change).pack(side=tk.LEFT)
        ttk.Radiobutton(mode_radio_frame, text="整体移动", variable=self.move_mode_var, 
                       value="all", command=self.on_mode_change).pack(side=tk.LEFT)
        
        # 类别选择
        ttk.Label(control_frame, text="选择类别:").pack(anchor=tk.W)
        self.category_combo = ttk.Combobox(control_frame, state="readonly")
        self.category_combo.pack(fill=tk.X, pady=(0, 10))
        self.category_combo.bind("<<ComboboxSelected>>", self.on_category_selected)
        
        # 项目列表
        ttk.Label(control_frame, text="项目列表:").pack(anchor=tk.W)
        self.item_listbox = tk.Listbox(control_frame, height=15)
        self.item_listbox.pack(fill=tk.X, pady=(0, 10))
        self.item_listbox.bind("<<ListboxSelect>>", self.on_item_selected)
        
        # 缩放控制
        ttk.Label(control_frame, text="缩放控制:").pack(anchor=tk.W)
        zoom_frame = ttk.Frame(control_frame)
        zoom_frame.pack(fill=tk.X, pady=(0, 10))
        
        ttk.Button(zoom_frame, text="+", width=3, command=self.zoom_in).pack(side=tk.LEFT)
        ttk.Button(zoom_frame, text="-", width=3, command=self.zoom_out).pack(side=tk.LEFT, padx=(5, 0))
        ttk.Button(zoom_frame, text="重置", command=self.reset_zoom).pack(side=tk.RIGHT)
        
        # 状态信息
        self.status_label = ttk.Label(control_frame, text="就绪")
        self.status_label.pack(pady=(10, 0))
        
        # 右侧画布区域
        canvas_frame = ttk.Frame(main_frame)
        canvas_frame.grid(row=0, column=1, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        # 创建画布和滚动条
        self.canvas = tk.Canvas(canvas_frame, bg="white", cursor="crosshair")
        self.h_scrollbar = ttk.Scrollbar(canvas_frame, orient=tk.HORIZONTAL, command=self.canvas.xview)
        self.v_scrollbar = ttk.Scrollbar(canvas_frame, orient=tk.VERTICAL, command=self.canvas.yview)
        
        self.canvas.configure(xscrollcommand=self.h_scrollbar.set, yscrollcommand=self.v_scrollbar.set)
        
        # 布局画布和滚动条
        self.canvas.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        self.h_scrollbar.grid(row=1, column=0, sticky=(tk.W, tk.E))
        self.v_scrollbar.grid(row=0, column=1, sticky=(tk.N, tk.S))
        
        # 绑定画布事件
        self.canvas.bind("<ButtonPress-1>", self.on_canvas_click)
        self.canvas.bind("<B1-Motion>", self.on_canvas_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_canvas_release)
        
        # 配置网格权重
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        main_frame.columnconfigure(1, weight=1)
        main_frame.rowconfigure(0, weight=1)
        canvas_frame.columnconfigure(0, weight=1)
        canvas_frame.rowconfigure(0, weight=1)
        
        # 初始化画布大小
        self.canvas.update_idletasks()
        
    def on_mode_change(self):
        self.move_mode = self.move_mode_var.get()
        self.status_label.config(text=f"当前模式: {'单独移动' if self.move_mode == 'single' else '整体移动'}")
        
    def open_image(self):
        file_path = filedialog.askopenfilename(
            title="选择图片文件",
            filetypes=[("图片文件", "*.png *.jpg *.jpeg *.bmp *.gif"), ("所有文件", "*.*")]
        )
        
        if file_path:
            try:
                self.image_path = file_path
                self.image_label.config(text=f"图片: {os.path.basename(file_path)}")
                self.load_image()
                self.status_label.config(text="图片加载成功")
            except Exception as e:
                messagebox.showerror("错误", f"无法加载图片: {str(e)}")
                self.status_label.config(text="图片加载失败")
    
    def open_json(self):
        file_path = filedialog.askopenfilename(
            title="选择JSON文件",
            filetypes=[("JSON文件", "*.json"), ("所有文件", "*.*")]
        )
        
        if file_path:
            try:
                with open(file_path, 'r') as f:
                    self.data = json.load(f)
                self.json_label.config(text=f"JSON: {os.path.basename(file_path)}")
                self.populate_categories()
                self.status_label.config(text="JSON加载成功")
            except Exception as e:
                messagebox.showerror("错误", f"无法打开JSON文件: {str(e)}")
                self.status_label.config(text="JSON加载失败")
    
    def load_image(self):
        if not self.image_path:
            return
            
        # 打开原始图片
        self.original_image = Image.open(self.image_path)
        self.image_width, self.image_height = self.original_image.size
        
        # 更新显示
        self.update_image_display()
    
    def update_image_display(self):
        if not self.original_image:
            return
            
        # 获取画布实际大小
        canvas_width = self.canvas.winfo_width()
        canvas_height = self.canvas.winfo_height()
        
        if canvas_width <= 1 or canvas_height <= 1:
            # 如果画布还没有大小，使用默认大小
            canvas_width = 800
            canvas_height = 600
        
        # 计算保持纵横比的缩放
        img_width, img_height = self.original_image.size
        ratio = min(canvas_width / img_width, canvas_height / img_height)
        new_width = int(img_width * ratio * self.zoom_factor)
        new_height = int(img_height * ratio * self.zoom_factor)
        
        self.displayed_image_width = new_width
        self.displayed_image_height = new_height
        
        # 缩放图片
        image = self.original_image.resize((new_width, new_height), Image.Resampling.LANCZOS)
        self.photo_image = ImageTk.PhotoImage(image)
        
        # 清除画布并显示图片
        self.canvas.delete("all")
        self.canvas_image = self.canvas.create_image(0, 0, anchor=tk.NW, image=self.photo_image)
        
        # 设置画布滚动区域
        self.canvas.configure(scrollregion=(0, 0, new_width, new_height))
        
        # 如果有JSON数据，绘制矩形
        if self.data and self.current_category:
            self.draw_rectangles()
    
    def populate_categories(self):
        if self.data:
            categories = [key for key in self.data.keys() if key != "img"]
            self.category_combo["values"] = categories
            if categories:
                self.category_combo.current(0)
                self.on_category_selected()
    
    def on_category_selected(self, event=None):
        category = self.category_combo.get()
        if category and category in self.data:
            self.current_category = category
            items = self.data[category]
            
            # 更新项目列表
            self.item_listbox.delete(0, tk.END)
            for i, item in enumerate(items):
                name = item.get("name", f"未命名_{i}")
                self.item_listbox.insert(tk.END, name)
            
            # 绘制矩形
            self.draw_rectangles()
            self.status_label.config(text=f"已加载类别: {category}")
    
    def on_item_selected(self, event):
        selection = self.item_listbox.curselection()
        if selection:
            item_index = selection[0]
            self.highlight_rectangle(item_index)
            self.status_label.config(text=f"已选择: {self.data[self.current_category][item_index].get('name', f'未命名_{item_index}')}")
    
    def draw_rectangles(self):
        # 清除所有矩形和文本
        for rect_id in self.rectangles.values():
            self.canvas.delete(rect_id)
        for text_id in self.texts.values():
            self.canvas.delete(text_id)
        self.rectangles.clear()
        self.texts.clear()
        
        if not self.current_category or not self.data or self.current_category not in self.data:
            return
        
        items = self.data[self.current_category]
        
        for i, item in enumerate(items):
            # 计算缩放后的坐标和尺寸
            left = item.get("left", 0) * self.zoom_factor
            top = item.get("top", 0) * self.zoom_factor
            width = item.get("Width", 0) * self.zoom_factor
            height = item.get("Height", 0) * self.zoom_factor
            
            # 确保坐标在画布范围内
            if left < 0:
                left = 0
            if top < 0:
                top = 0
            if left + width > self.displayed_image_width:
                left = self.displayed_image_width - width
            if top + height > self.displayed_image_height:
                top = self.displayed_image_height - height
            
            # 创建矩形
            rect_id = self.canvas.create_rectangle(
                left, top, left + width, top + height,
                outline="red", width=2, fill="", tags=f"rect_{i}"
            )
            
            # 存储矩形ID
            self.rectangles[i] = rect_id
            
            # 添加标签
            name = item.get("name", f"未命名_{i}")
            text_id = self.canvas.create_text(
                left + width/2, top + height/2,
                text=name, fill="red", tags=f"text_{i}"
            )
            self.texts[i] = text_id
    
    def highlight_rectangle(self, item_index):
        # 重置所有矩形的颜色
        for i in range(len(self.data[self.current_category])):
            self.canvas.itemconfig(self.rectangles[i], outline="red", width=2)
        
        # 高亮选中的矩形
        if item_index in self.rectangles:
            self.canvas.itemconfig(self.rectangles[item_index], outline="yellow", width=3)
    
    def on_canvas_click(self, event):
        # 获取画布坐标（考虑滚动）
        x = self.canvas.canvasx(event.x)
        y = self.canvas.canvasy(event.y)
        
        # 查找点击的是哪个矩形
        clicked_items = self.canvas.find_overlapping(x-1, y-1, x+1, y+1)
        
        for item in clicked_items:
            tags = self.canvas.gettags(item)
            for tag in tags:
                if tag.startswith("rect_"):
                    item_index = int(tag.split("_")[1])
                    self.dragging = True
                    self.drag_item = item_index
                    self.drag_start_x = x
                    self.drag_start_y = y
                    
                    # 更新列表选择
                    self.item_listbox.selection_clear(0, tk.END)
                    self.item_listbox.selection_set(item_index)
                    self.highlight_rectangle(item_index)
                    
                    self.status_label.config(text=f"开始拖动: {self.data[self.current_category][item_index].get('name', f'未命名_{item_index}')}")
                    return
        
        # 如果没有点击到矩形，取消任何选择
        self.item_listbox.selection_clear(0, tk.END)
        for i in range(len(self.data[self.current_category])):
            self.canvas.itemconfig(self.rectangles[i], outline="red", width=2)
        self.status_label.config(text="点击了背景区域")
    
    def on_canvas_drag(self, event):
        if self.dragging and self.drag_item is not None:
            # 获取画布坐标（考虑滚动）
            x = self.canvas.canvasx(event.x)
            y = self.canvas.canvasy(event.y)
            
            # 计算移动距离
            dx = x - self.drag_start_x
            dy = y - self.drag_start_y
            
            if self.move_mode == "single":
                # 单独移动模式：只移动选中的矩形和文本
                self.canvas.move(self.rectangles[self.drag_item], dx, dy)
                self.canvas.move(self.texts[self.drag_item], dx, dy)
            else:
                # 整体移动模式：移动当前类别的所有矩形和文本
                for i in range(len(self.data[self.current_category])):
                    self.canvas.move(self.rectangles[i], dx, dy)
                    self.canvas.move(self.texts[i], dx, dy)
            
            # 更新起始位置
            self.drag_start_x = x
            self.drag_start_y = y
            
            self.status_label.config(text="拖动中...")
    
    def on_canvas_release(self, event):
        if self.dragging and self.drag_item is not None:
            # 更新JSON数据中的坐标
            if self.current_category and self.data and self.current_category in self.data:
                items = self.data[self.current_category]
                
                if self.move_mode == "single":
                    # 单独移动模式：只更新选中的矩形坐标
                    if self.drag_item < len(items):
                        # 获取矩形的新位置
                        coords = self.canvas.coords(self.rectangles[self.drag_item])
                        
                        # 转换回原始坐标（考虑缩放）
                        items[self.drag_item]["left"] = int(coords[0] / self.zoom_factor)
                        items[self.drag_item]["top"] = int(coords[1] / self.zoom_factor)
                        
                        self.status_label.config(text=f"已更新: {items[self.drag_item].get('name', f'未命名_{self.drag_item}')}")
                else:
                    # 整体移动模式：更新所有矩形的坐标
                    for i in range(len(items)):
                        # 获取矩形的新位置
                        coords = self.canvas.coords(self.rectangles[i])
                        
                        # 转换回原始坐标（考虑缩放）
                        items[i]["left"] = int(coords[0] / self.zoom_factor)
                        items[i]["top"] = int(coords[1] / self.zoom_factor)
                    
                    self.status_label.config(text=f"已更新所有 {self.current_category} 的坐标")
            
            self.dragging = False
            self.drag_item = None
    
    def zoom_in(self):
        self.zoom_factor *= 1.2
        self.update_image_display()
        self.status_label.config(text=f"已放大: {int(self.zoom_factor * 100)}%")
    
    def zoom_out(self):
        self.zoom_factor /= 1.2
        self.update_image_display()
        self.status_label.config(text=f"已缩小: {int(self.zoom_factor * 100)}%")
    
    def reset_zoom(self):
        self.zoom_factor = 1.0
        self.update_image_display()
        self.status_label.config(text="已重置缩放")
    
    def save_json(self):
        if not self.data:
            messagebox.showwarning("警告", "没有JSON数据可保存")
            return
        
        file_path = filedialog.asksaveasfilename(
            title="保存JSON文件",
            defaultextension=".json",
            filetypes=[("JSON文件", "*.json"), ("所有文件", "*.*")]
        )
        
        if file_path:
            try:
                with open(file_path, 'w') as f:
                    json.dump(self.data, f, indent=4)
                messagebox.showinfo("成功", f"文件已保存到: {file_path}")
                self.status_label.config(text=f"已保存: {os.path.basename(file_path)}")
            except Exception as e:
                messagebox.showerror("错误", f"保存文件时出错: {str(e)}")
                self.status_label.config(text="保存失败")

if __name__ == "__main__":
    root = tk.Tk()
    app = CoordinateEditor(root)
    root.mainloop()