# Framer-export-plugin
a free export plugin using a backend server hosted on the local machine

the plugin spits out the zip file containing the code and just need to run directly on the local machine using "npm install" --> npm run dev  

## SET UP
### **clone the repo **
git clone https://github.com/harish0stack/Framer-export-plugin
cd Framer-export-plugin
### **Step 1: Setup the Backend Server (The Extractor)**

1. Open a terminal and navigate to the server folder:
    
    ```
    bash
    cd server
    ```
    
2. Install dependencies (This automatically downloads Playwright, ESBuild, and the Chromium browsers for their specific OS):
    
    ```
    bash
    npm install
    ```
    
3. Start the server:*(The server is now running on `localhost:4000`)*
    
    ```
    bash
    npm run dev
    ```
    

### **Step 2: Setup the Frontend (The UI for requesting exports)**

*(Assuming your UI is in the root directory)*

1. Open a **new** terminal window and navigate to the root frontend folder:
    
    ```
    bash
    cd Framer-export-plugin or cd ..(to go back in the root folder)
    ```
    
2. Install frontend dependencies:
    
    ```
    bash
    npm install
    ```
    
3. Start the frontend interface:*(The UI is now running on `localhost:5173`)*
    
    ```
    bash
    npm run dev
    ```
    

### **Step 3: What happens when they test an export?**

1. The developer enters a Framer URL into the frontend UI.
2. The Node server uses Playwright to scrape it and ESBuild to bundle it.
3. It generates a `react-app.zip` containing the extracted code and its own `package.json` configured with SWC.
4. When the developer unzips that folder, they just run `npm install` and `npm run dev` inside it to see the final, working components.
