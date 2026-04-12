Steps to Add Another API

**1. Access the Server via G-Zien SSH**

Run the following command to SSH into the server:

   ssh -i ~/.ssh/g-zien-dev.pem ubuntu@ec2-54-161-129-186.compute-1.amazonaws.com


**2. Navigate to the Nginx Configuration Directory:**

Go to the root directory using

    cd /

Move to the Nginx sites-available directory:

    cd /etc/nginx/sites-available

**3. Locate the Default Configuration File:**

In the sites-available directory, you will find a file named default (sometimes displayed as default.conf). By default (😉), this file is not writable

**4. Edit the Default Configuration File
To edit the file, use the following command:**

     sudo nano default

This will open the file in the Nano text editor with elevated permissions, allowing you to make changes.

This is the format how to add another API in nginx

    location /{route}/ {
    rewrite ^/{route}/(.*)$ /$1 break;
    proxy_pass http://localhost:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    }

Note: Replace {<span style="color: green;"> **route** </span>} with your desired API route.

**4. Push Changes to NGINX**

To push the changes input these commands

    sudo ln -s /etc/nginx/sites-available/{route} /etc/nginx/sites-enabled/
    sudo nginx -t
    sudo systemctl reload nginx
